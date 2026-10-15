//! Daily forecast only. The provider receives coordinates, never trip names or credentials.
use super::{ApiError, App, Auth, internal, load_auth, now, read_trip};
use axum::{
    Extension, Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde_json::{Value, json};
use std::{collections::HashMap, process::Stdio, sync::OnceLock, time::Duration};
use tokio::{io::AsyncReadExt, process::Command, sync::Mutex};

#[derive(Clone)]
struct CachedForecast {
    updated: i64,
    data: Option<Value>,
    retry_after: i64,
}
impl CachedForecast {
    fn fresh(&self, time: i64) -> bool {
        time < self.retry_after || (self.data.is_some() && time - self.updated < 3600)
    }
    fn usable(self, time: i64) -> Result<Self, ApiError> {
        if self.data.is_some() && time - self.updated <= 86400 {
            Ok(self)
        } else {
            Err(unavailable())
        }
    }
}
#[derive(Default)]
struct Cache {
    entries: HashMap<String, CachedForecast>,
    minute: (i64, u32),
    day: (i64, u32),
}
struct ForecastCache {
    state: Mutex<Cache>,
    upstream: tokio::sync::Semaphore,
}
impl ForecastCache {
    fn new() -> Self {
        Self {
            state: Mutex::new(Cache::default()),
            upstream: tokio::sync::Semaphore::new(1),
        }
    }
    async fn get<F, Fut>(&self, key: &str, download: F) -> Result<CachedForecast, ApiError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<Value, ApiError>>,
    {
        let existing = self.state.lock().await.entries.get(key).cloned();
        if let Some(entry) = existing.as_ref().filter(|entry| entry.fresh(now())) {
            return entry.clone().usable(now());
        }
        // Only misses wait for upstream capacity. A slow provider never blocks cached cities.
        let Ok(Ok(_permit)) =
            tokio::time::timeout(Duration::from_secs(13), self.upstream.acquire()).await
        else {
            return existing.ok_or_else(unavailable)?.usable(now());
        };
        let time = now();
        let mut cache = self.state.lock().await;
        // A previous miss may have filled this same location while we waited for capacity.
        let existing = cache.entries.get(key).cloned();
        if let Some(entry) = existing.as_ref().filter(|entry| entry.fresh(time)) {
            return entry.clone().usable(time);
        }
        if cache.minute.0 != time / 60 {
            cache.minute = (time / 60, 0);
        }
        if cache.day.0 != time / 86400 {
            cache.day = (time / 86400, 0);
        }
        if cache.minute.1 >= 10 || cache.day.1 >= 1000 {
            return existing.ok_or_else(unavailable)?.usable(time);
        }
        cache.minute.1 += 1;
        cache.day.1 += 1;
        drop(cache);
        let result = download().await;
        let completed = now();
        let entry = match result {
            Ok(data) => CachedForecast {
                updated: completed,
                data: Some(data),
                retry_after: 0,
            },
            Err(_) => match existing
                .filter(|entry| entry.data.is_some() && completed - entry.updated <= 86400)
            {
                Some(mut entry) => {
                    entry.retry_after = completed + 120;
                    entry
                }
                None => CachedForecast {
                    updated: completed,
                    data: None,
                    retry_after: completed + 120,
                },
            },
        };
        let mut cache = self.state.lock().await;
        if cache.entries.len() >= 128
            && !cache.entries.contains_key(key)
            && let Some(oldest) = cache
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.updated)
                .map(|(key, _)| key.clone())
        {
            cache.entries.remove(&oldest);
        }
        cache.entries.insert(key.into(), entry.clone());
        entry.usable(completed)
    }
}
static CACHE: OnceLock<ForecastCache> = OnceLock::new();

fn alternative(e: &Value) -> bool {
    e["alternative"]
        .as_bool()
        .unwrap_or(e["slot"] == "alternative")
}
fn coordinate(e: &Value) -> Option<(f64, f64)> {
    let lat = e["lat"].as_f64()?;
    let lng = e["lng"].as_f64()?;
    (lat.is_finite()
        && lng.is_finite()
        && (-90.0..=90.0).contains(&lat)
        && (-180.0..=180.0).contains(&lng))
    .then_some((lat, lng))
}
// Choose an actual stop in the most populated area, rather than averaging distant cities.
fn location(day: &Value) -> Option<(f64, f64, String)> {
    let events: Vec<_> = day["events"]
        .as_array()?
        .iter()
        .filter(|e| !alternative(e))
        .collect();
    let activities: Vec<_> = events
        .iter()
        .copied()
        .filter(|e| {
            matches!(
                e["kind"].as_str(),
                Some("sight" | "food" | "walk" | "nature" | "visit" | "shopping" | "activity")
            ) && e["slot"] != "transport"
        })
        .filter(|e| coordinate(e).is_some())
        .collect();
    let chosen = activities.iter().copied().max_by_key(|e| {
        let (lat, lng) = coordinate(e).unwrap();
        activities
            .iter()
            .filter(|other| {
                let (a, b) = coordinate(other).unwrap();
                (a - lat).abs() < 0.1 && (b - lng).abs() < 0.1
            })
            .count()
    });
    if let Some(e) = chosen.or_else(|| {
        events
            .iter()
            .copied()
            .find(|e| e["kind"] == "hotel" && coordinate(e).is_some())
    }) {
        let (lat, lng) = coordinate(e)?;
        return Some((lat, lng, e["title"].as_str().unwrap_or("").into()));
    }
    let e = events.iter().rev().find(|e| coordinate(e).is_some())?;
    if let Some((lat, lng)) = coordinate(&e["to"]) {
        Some((lat, lng, e["to"]["name"].as_str().unwrap_or("").into()))
    } else {
        let (lat, lng) = coordinate(e)?;
        Some((lat, lng, e["title"].as_str().unwrap_or("").into()))
    }
}
fn unavailable() -> ApiError {
    ApiError(StatusCode::SERVICE_UNAVAILABLE, "天气暂不可用".into(), None)
}
async fn fetch(lat: f64, lng: f64) -> Result<Value, ApiError> {
    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={lat:.3}&longitude={lng:.3}&daily=weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max&timezone=auto&forecast_days=16"
    );
    let mut child = Command::new("curl")
        .args([
            "--disable",
            "--silent",
            "--show-error",
            "--fail",
            "--proto",
            "=https",
            "--connect-timeout",
            "4",
            "--max-time",
            "10",
            "--max-filesize",
            "65536",
            &url,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            eprintln!("weather fetch start failed: {e}");
            unavailable()
        })?;
    let result = tokio::time::timeout(Duration::from_secs(12), async {
        let mut bytes = Vec::new();
        child
            .stdout
            .take()
            .ok_or_else(unavailable)?
            .take(65537)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| unavailable())?;
        if bytes.len() > 65536 {
            return Err(unavailable());
        }
        if !child.wait().await.map_err(|_| unavailable())?.success() {
            return Err(unavailable());
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
        if value["daily"]["time"]
            .as_array()
            .is_none_or(|a| a.is_empty() || a.len() > 16)
        {
            return Err(unavailable());
        }
        Ok(value)
    })
    .await
    .map_err(|_| unavailable())?;
    if result.is_err() {
        eprintln!("weather provider request failed or returned invalid data");
    }
    result
}
fn forecast(data: &Value, date: &str) -> Value {
    let Some(times) = data["daily"]["time"].as_array() else {
        return json!({"status":"unavailable"});
    };
    let Some(i) = times.iter().position(|v| v.as_str() == Some(date)) else {
        return json!({"status":if times.first().and_then(Value::as_str).is_some_and(|first| date < first) {"past"} else {"future"}});
    };
    let daily = &data["daily"];
    let number = |field: &str, min: f64, max: f64| {
        daily[field][i]
            .as_f64()
            .filter(|v| v.is_finite() && *v >= min && *v <= max)
    };
    let low = number("temperature_2m_min", -100.0, 70.0);
    let high = number("temperature_2m_max", -100.0, 70.0);
    let code = daily["weather_code"][i].as_u64().filter(|v| *v <= 99);
    if low.is_none() || high.is_none() || code.is_none() || low > high {
        return json!({"status":"unavailable"});
    }
    json!({"status":"ready","code":code,"low":low,"high":high,"precipitation":number("precipitation_probability_max",0.0,100.0)})
}
pub async fn daily(
    State(app): State<App>,
    Extension(auth): Extension<Auth>,
    Path((id, day_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let trip = app
        .run(move |c| {
            let live = load_auth(c, &auth.hash)?;
            read_trip(c, &id, &live.account_id)
        })
        .await?;
    let day = trip
        .input
        .days
        .iter()
        .find(|d| d["id"].as_str() == Some(&day_id))
        .ok_or(ApiError(StatusCode::NOT_FOUND, "日程不存在".into(), None))?;
    let date = day["date"]
        .as_str()
        .ok_or_else(|| internal("invalid weather date"))?;
    let mut base = json!({"city":day["city"],"date":date,"status":"no-location"});
    let Some((lat, lng, reference)) = location(day) else {
        return Ok(Json(base));
    };
    base["reference"] = json!(reference);
    // A one-day allowance handles local dates around the international date line.
    let ordinal = super::model::date(date).ok_or_else(|| internal("invalid weather date"))?;
    let today = super::model::date("1970-01-01").unwrap() + now() / 86400;
    if ordinal < today - 1 || ordinal > today + 16 {
        base["status"] = json!(if ordinal < today - 1 {
            "past"
        } else {
            "future"
        });
        return Ok(Json(base));
    }
    let key = format!("{lat:.3},{lng:.3}");
    let entry = CACHE
        .get_or_init(ForecastCache::new)
        .get(&key, || fetch(lat, lng))
        .await?;
    let mut result = forecast(entry.data.as_ref().ok_or_else(unavailable)?, date);
    result["updatedAt"] = json!(entry.updated);
    result["stale"] = json!(now() - entry.updated >= 3600);
    base.as_object_mut()
        .unwrap()
        .extend(result.as_object().unwrap().clone());
    Ok(Json(base))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn fresh_cities_bypass_slow_fetch_and_same_city_misses_share_result() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let cache = Arc::new(ForecastCache::new());
        cache.state.lock().await.entries.insert(
            "cached".into(),
            CachedForecast {
                updated: now(),
                data: Some(json!({"city":"cached"})),
                retry_after: 0,
            },
        );
        let started = Arc::new(tokio::sync::Notify::new());
        let finish = Arc::new(tokio::sync::Notify::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let first = {
            let cache = cache.clone();
            let started = started.clone();
            let finish = finish.clone();
            let calls = calls.clone();
            tokio::spawn(async move {
                cache
                    .get("slow", || async {
                        calls.fetch_add(1, Ordering::SeqCst);
                        started.notify_one();
                        finish.notified().await;
                        Ok(json!({"city":"slow"}))
                    })
                    .await
            })
        };
        started.notified().await;
        let second = {
            let cache = cache.clone();
            let calls = calls.clone();
            tokio::spawn(async move {
                cache
                    .get("slow", || async {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(json!({"city":"duplicate"}))
                    })
                    .await
            })
        };
        let hit = tokio::time::timeout(
            Duration::from_millis(200),
            cache.get("cached", || async { panic!("fresh cache must not fetch") }),
        )
        .await;
        finish.notify_one();
        assert_eq!(first.await.unwrap().unwrap().data.unwrap()["city"], "slow");
        assert_eq!(second.await.unwrap().unwrap().data.unwrap()["city"], "slow");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(hit.unwrap().unwrap().data.unwrap()["city"], "cached");
    }
    #[tokio::test]
    async fn failed_refresh_cools_down_preserves_age_and_never_serves_overage_data() {
        let cache = ForecastCache::new();
        let updated = now() - 3601;
        cache.state.lock().await.entries.insert(
            "old".into(),
            CachedForecast {
                updated,
                data: Some(json!({"daily":{}})),
                retry_after: 0,
            },
        );
        let stale = cache
            .get("old", || async { Err(unavailable()) })
            .await
            .unwrap();
        assert_eq!(stale.updated, updated);
        assert!(stale.retry_after > now());
        let cooled = cache
            .get("old", || async { panic!("failed refresh must cool down") })
            .await
            .unwrap();
        assert_eq!(cooled.updated, updated);
        cache.state.lock().await.entries.insert(
            "missing".into(),
            CachedForecast {
                updated: now(),
                data: None,
                retry_after: now() + 120,
            },
        );
        assert!(
            cache
                .get("missing", || async {
                    panic!("negative cache must cool down")
                })
                .await
                .is_err()
        );
        let mut state = cache.state.lock().await;
        state.day = (now() / 86400, 1000);
        state.entries.insert(
            "expired".into(),
            CachedForecast {
                updated: now() - 86401,
                data: Some(json!({})),
                retry_after: 0,
            },
        );
        drop(state);
        assert!(
            cache
                .get("expired", || async {
                    panic!("exhausted quota must not fetch")
                })
                .await
                .is_err()
        );
    }
    #[test]
    fn chooses_activity_cluster_and_excludes_alternatives() {
        let day = json!({"events":[{"kind":"sight","lat":48.1,"lng":11.5,"title":"A"},{"kind":"food","lat":48.11,"lng":11.51,"title":"B"},{"kind":"sight","lat":50.0,"lng":8.0,"title":"C"},{"kind":"sight","lat":50.0,"lng":8.0,"alternative":true},{"kind":"hotel","lat":50.0,"lng":8.0}]});
        assert_eq!(location(&day).unwrap().0, 48.11);
        assert_eq!(location(&json!({"events":[{"kind":"flight","lat":1,"lng":2,"to":{"lat":3,"lng":4,"name":"抵达"}}]})).unwrap(),(3.0,4.0,"抵达".into()));
        assert!(location(&json!({"events":[]})).is_none());
    }
    #[test]
    fn forecast_dates_and_missing_values_are_not_fabricated() {
        let data = json!({"daily":{"time":["2026-10-15"],"weather_code":[3],"temperature_2m_min":[10],"temperature_2m_max":[19],"precipitation_probability_max":[null]}});
        assert_eq!(forecast(&data, "2026-10-15")["precipitation"], Value::Null);
        assert_eq!(forecast(&data, "2026-10-14")["status"], "past");
        assert_eq!(forecast(&data, "2026-11-01")["status"], "future");
        let mut broken = data;
        broken["daily"]["temperature_2m_min"][0] = Value::Null;
        assert_eq!(forecast(&broken, "2026-10-15")["status"], "unavailable");
    }
}
