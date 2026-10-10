//! Authorized, bounded map preparation. Only coordinates and day IDs leave the backend.
use super::{ApiError, App, Auth, internal, load_auth, read_trip};
use axum::{
    Extension, Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::Semaphore,
};
const PIPE_LIMIT: usize = 65536;
static DOWNLOAD: OnceLock<Arc<Semaphore>> = OnceLock::new();
static READERS: OnceLock<Arc<Semaphore>> = OnceLock::new();
fn failed() -> ApiError {
    ApiError(
        StatusCode::INTERNAL_SERVER_ERROR,
        "地图资源尚未准备完成，请稍后重试".into(),
        None,
    )
}
pub async fn cached(
    State(app): State<App>,
    Extension(a): Extension<Auth>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    run(app, a, id, true).await
}
pub async fn prepare(
    State(app): State<App>,
    Extension(a): Extension<Auth>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    run(app, a, id, false).await
}
async fn run(app: App, a: Auth, id: String, cached: bool) -> Result<Json<Value>, ApiError> {
    // Check ownership before claiming download capacity, including after a queued revocation.
    let trip = app
        .run(move |c| {
            let live = load_auth(c, &a.hash)?;
            read_trip(c, &id, &live.account_id)
        })
        .await?;
    let mut days = Vec::new();
    let mut ids = HashSet::new();
    for day in &trip.input.days {
        let id = day
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| internal("invalid stored map day"))?;
        let source_events = day
            .get("events")
            .and_then(Value::as_array)
            .ok_or_else(|| internal("invalid stored map events"))?;
        let events: Vec<Value> = source_events
            .iter()
            .map(|event| {
                let mut coordinate = json!({"lat":event["lat"],"lng":event["lng"]});
                if let Some(to) = event.get("to") {
                    coordinate["to"] = json!({"lat":to["lat"],"lng":to["lng"]});
                }
                coordinate
            })
            .collect();
        ids.insert(id.to_owned());
        days.push(json!({"id":id,"events":events}));
    }
    let payload = serde_json::to_vec(&json!({"days":days})).map_err(internal)?;
    if payload.len() > 1024 * 1024 {
        return Err(ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            "地图请求超过 1 MiB".into(),
            None,
        ));
    }
    let gate = if cached {
        READERS.get_or_init(|| Arc::new(Semaphore::new(4)))
    } else {
        DOWNLOAD.get_or_init(|| Arc::new(Semaphore::new(1)))
    };
    let permit = gate.clone().try_acquire_owned().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "地图准备繁忙，请稍后重试".into(),
            Some(30),
        )
    })?;
    let script = std::env::var("TRAVEL_MAP_PACK_SCRIPT")
        .unwrap_or_else(|_| "/opt/travel/map-pack.py".into());
    if !std::path::Path::new(&script).is_absolute() {
        return Err(internal("map pack script must be absolute"));
    }
    // A disconnected HTTP client detaches this supervised job. Its permit stays held until
    // completion/timeout; it must not kill the Python supervisor and release the slot early.
    tokio::spawn(async move {
        let _permit = permit;
        let timeout = Duration::from_secs(if cached { 10 } else { 200 });
        let data = execute(&script, payload, cached, timeout).await?;
        validate_manifest(&data, &ids)?;
        Ok(Json(data))
    })
    .await
    .map_err(internal)?
}
async fn read_bounded<R: tokio::io::AsyncRead + Unpin>(stream: &mut R) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    stream
        .take((PIPE_LIMIT + 1) as u64)
        .read_to_end(&mut out)
        .await?;
    if out.len() > PIPE_LIMIT {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "map process output exceeds bound",
        ));
    }
    Ok(out)
}
async fn execute(
    script: &str,
    payload: Vec<u8>,
    cached: bool,
    timeout: Duration,
) -> Result<Value, ApiError> {
    let mut command = Command::new("/usr/bin/python3");
    command.arg(script);
    if cached {
        command.arg("--cached-only");
    }
    command
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|_| failed())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| internal("map input pipe unavailable"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| internal("map output pipe unavailable"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| internal("map diagnostic pipe unavailable"))?;
    let operation = async {
        let writer = async move {
            stdin.write_all(&payload).await?;
            stdin.shutdown().await?;
            // Python reads the complete JSON until EOF; shutdown alone leaves ChildStdin open.
            drop(stdin);
            Ok::<(), std::io::Error>(())
        };
        let reader = async {
            let (out, _err) =
                tokio::try_join!(read_bounded(&mut stdout), read_bounded(&mut stderr))?;
            Ok::<_, std::io::Error>(out)
        };
        let (_, out) = tokio::try_join!(writer, reader)?;
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((status, out))
    };
    let (status, out) = match tokio::time::timeout(timeout, operation).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            let _ = child.kill().await;
            return Err(failed());
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "地图准备超时，请稍后重试".into(),
                None,
            ));
        }
    };
    if !status.success() {
        return Err(failed());
    }
    serde_json::from_slice(&out).map_err(|_| failed())
}
fn valid_pack(pack: &Value) -> bool {
    let Some(fields) = pack.as_object() else {
        return false;
    };
    if fields.len() != 3 {
        return false;
    }
    let Some(url) = pack.get("url").and_then(Value::as_str) else {
        return false;
    };
    let Some(name) = url
        .strip_prefix("/map-packs/")
        .and_then(|s| s.strip_suffix(".pmtiles"))
    else {
        return false;
    };
    if name.len() != 64
        || !name
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return false;
    }
    let Some(b) = pack.get("bounds").and_then(Value::as_array) else {
        return false;
    };
    if b.len() != 4 {
        return false;
    }
    let Some(n) = b.iter().map(Value::as_f64).collect::<Option<Vec<_>>>() else {
        return false;
    };
    n.iter().all(|v| v.is_finite())
        && n[0] >= -180.
        && n[2] <= 180.
        && n[1] >= -90.
        && n[3] <= 90.
        && n[0] <= n[2]
        && n[1] <= n[3]
        && pack
            .get("maxZoom")
            .and_then(Value::as_u64)
            .is_some_and(|z| z <= 14)
}
fn validate_manifest(data: &Value, ids: &HashSet<String>) -> Result<(), ApiError> {
    let valid = (|| {
        let root = data.as_object()?;
        if root.len() != 3 {
            return None;
        }
        let overview = root.get("overview")?;
        if !overview.is_null() && !valid_pack(overview) {
            return None;
        }
        let days = root.get("days")?.as_object()?;
        if days
            .iter()
            .any(|(id, p)| !ids.contains(id) || !valid_pack(p))
        {
            return None;
        }
        let missing = root.get("missing")?.as_array()?;
        if missing.len() > ids.len() + 1 {
            return None;
        }
        let mut seen = HashSet::new();
        for m in missing {
            if m.as_object()?.len() != 2 {
                return None;
            }
            let id = m.get("id")?.as_str()?;
            if (id != "overview" && !ids.contains(id))
                || !seen.insert(id)
                || !(matches!(m.get("reason")?.as_str()?, "no-events" | "not-cached"))
            {
                return None;
            }
        }
        Some(())
    })()
    .is_some();
    if valid {
        Ok(())
    } else {
        Err(internal("map manifest contract mismatch"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_private_metadata_external_urls_and_unknown_day_ids() {
        let ids = HashSet::from(["day-1".into()]);
        let mut m =
            json!({"overview":null,"days":{},"missing":[{"id":"day-1","reason":"no-events"}]});
        assert!(validate_manifest(&m, &ids).is_ok());
        m["secret"] = json!("private title");
        assert!(validate_manifest(&m, &ids).is_err());
        assert!(!valid_pack(
            &json!({"url":"https://internal.example/file","bounds":[0,0,1,1],"maxZoom":10})
        ));
        assert!(validate_manifest(&json!({"overview":null,"days":{},"missing":[{"id":"not-owned","reason":"not-cached"}]}),&ids).is_err());
    }
    #[tokio::test]
    async fn limits_child_output_and_timeout_without_exposing_stderr() {
        let path =
            std::env::temp_dir().join(format!("travel-map-test-{}.py", uuid::Uuid::new_v4()));
        std::fs::write(&path,"import sys,time\nsys.stdin.read()\nsys.stdout.write('x'*65537)\nsys.stdout.flush()\ntime.sleep(10)\n").unwrap();
        assert_eq!(
            execute(
                path.to_str().unwrap(),
                b"{}".to_vec(),
                false,
                Duration::from_secs(2)
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::INTERNAL_SERVER_ERROR
        );
        std::fs::write(&path, "import sys,time\nsys.stdin.read()\ntime.sleep(10)\n").unwrap();
        assert!(
            execute(
                path.to_str().unwrap(),
                b"{}".to_vec(),
                false,
                Duration::from_millis(50)
            )
            .await
            .err()
            .unwrap()
            .1
            .contains("超时")
        );
        std::fs::write(&path,"import sys\nsys.stdin.read()\nprint('private-secret-in-child-error',file=sys.stderr)\nsys.exit(1)\n").unwrap();
        let error = execute(
            path.to_str().unwrap(),
            b"{}".to_vec(),
            false,
            Duration::from_secs(2),
        )
        .await
        .err()
        .unwrap();
        assert!(!error.1.contains("private-secret"));
        std::fs::remove_file(path).unwrap();
    }
}
