use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Packing {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_items: Option<Vec<Item>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_notes: Option<String>,
    pub extra_items: Vec<Item>,
    pub checked_ids: Vec<String>,
    pub hidden_base_ids: Vec<String>,
    pub notes: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Item {
    pub id: String,
    pub label: String,
    pub category: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TripInput {
    pub name: String,
    pub destination: String,
    pub start_date: String,
    pub end_date: String,
    pub timezone: String,
    pub days: Vec<Value>,
    pub packing: Packing,
    pub version: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trip {
    pub id: String,
    #[serde(flatten)]
    pub input: TripInput,
    pub updated_at: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Template {
    pub items: Vec<Item>,
    pub notes: String,
    pub version: i64,
}

fn bounded(s: &str, max: usize, required: bool) -> bool {
    s.chars().count() <= max
        && (!required || !s.trim().is_empty())
        && !s.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
}
fn id(s: &str) -> bool {
    bounded(s, 80, true)
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c))
}
fn date(s: &str) -> Option<i64> {
    if !s.is_ascii() || s.len() != 10 || s.as_bytes()[4] != b'-' || s.as_bytes()[7] != b'-' {
        return None;
    }
    if !s
        .bytes()
        .enumerate()
        .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        return None;
    }
    let y: i64 = s[..4].parse().ok()?;
    let m: usize = s[5..7].parse().ok()?;
    let d: i64 = s[8..].parse().ok()?;
    if !(1900..=2200).contains(&y) || !(1..=12).contains(&m) {
        return None;
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let lengths = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if d < 1 || d > lengths[m - 1] {
        return None;
    }
    let yy = y - 1;
    Some(365 * yy + yy / 4 - yy / 100 + yy / 400 + lengths[..m - 1].iter().sum::<i64>() + d)
}
fn text<'a>(v: &'a Value, k: &str, max: usize, required: bool) -> Result<Option<&'a str>, String> {
    match v.get(k) {
        None if !required => Ok(None),
        Some(Value::String(s)) if bounded(s, max, required) => Ok(Some(s)),
        _ => Err(format!("invalid {k}")),
    }
}
fn coord(v: &Value, k: &str, max: f64) -> bool {
    v.get(k)
        .and_then(Value::as_f64)
        .is_some_and(|n| n.is_finite() && n.abs() <= max)
}
fn time(s: &str) -> bool {
    s.is_ascii()
        && s.len() == 5
        && s.as_bytes()[2] == b':'
        && s.bytes()
            .enumerate()
            .all(|(i, b)| i == 2 || b.is_ascii_digit())
        && s[..2].parse::<u8>().is_ok_and(|n| n < 24)
        && s[3..].parse::<u8>().is_ok_and(|n| n < 60)
}
fn unique_ids(values: &[String]) -> bool {
    values.len() <= 300
        && values.iter().all(|s| id(s))
        && values.iter().collect::<HashSet<_>>().len() == values.len()
}
pub fn validate_items(items: &[Item]) -> Result<(), String> {
    if items.len() > 100 {
        return Err("too many packing items".into());
    }
    let mut ids = HashSet::new();
    for i in items {
        if !id(&i.id)
            || !ids.insert(&i.id)
            || !bounded(&i.label, 200, true)
            || !bounded(&i.category, 80, true)
        {
            return Err("invalid packing item".into());
        }
    }
    Ok(())
}
pub fn validate_template(t: &Template) -> Result<(), String> {
    validate_items(&t.items)?;
    if !bounded(&t.notes, 10000, false) || t.version < 1 {
        return Err("invalid template".into());
    }
    Ok(())
}
pub fn validate_trip(t: &TripInput) -> Result<(), String> {
    if !bounded(&t.name, 160, true)
        || !bounded(&t.destination, 200, false)
        || !bounded(&t.timezone, 80, true)
        || !t
            .timezone
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/_+-".contains(c))
    {
        return Err("invalid trip metadata".into());
    }
    let start = date(&t.start_date).ok_or("invalid startDate")?;
    let end = date(&t.end_date).ok_or("invalid endDate")?;
    if end < start
        || end - start >= 60
        || t.days.is_empty()
        || t.days.len() > 60
        || t.days.len() as i64 != end - start + 1
    {
        return Err("days must cover a continuous range of at most 60 days".into());
    }
    let mut ids = HashSet::new();
    for (index, d) in t.days.iter().enumerate() {
        let di = text(d, "id", 80, true)?.unwrap();
        if !id(di) || !ids.insert(di.to_owned()) {
            return Err("duplicate or invalid id".into());
        }
        if date(text(d, "date", 10, true)?.unwrap()) != Some(start + index as i64) {
            return Err("day dates must be continuous".into());
        }
        text(d, "city", 200, false)?;
        text(d, "title", 300, false)?;
        let events = d
            .get("events")
            .and_then(Value::as_array)
            .ok_or("invalid events")?;
        if events.len() > 40 {
            return Err("too many events".into());
        }
        for e in events {
            let ei = text(e, "id", 80, true)?.unwrap();
            if !id(ei) || !ids.insert(ei.to_owned()) {
                return Err("duplicate or invalid id".into());
            }
            text(e, "title", 300, true)?;
            let kind = text(e, "kind", 20, true)?.unwrap();
            if !["flight", "train", "taxi", "food", "sight", "hotel", "walk"].contains(&kind) {
                return Err("invalid kind".into());
            }
            if !coord(e, "lat", 90.) || !coord(e, "lng", 180.) {
                return Err("invalid coordinates".into());
            }
            for k in ["time", "endTime"] {
                if text(e, k, 5, false)?.is_some_and(|s| !time(s)) {
                    return Err("invalid time".into());
                }
            }
            if let (Some(a), Some(b)) = (
                e.get("time").and_then(Value::as_str),
                e.get("endTime").and_then(Value::as_str),
            ) && a > b
            {
                return Err("endTime precedes time".into());
            }
            if let Some(slot) = text(e, "slot", 20, false)? {
                let compatible = match slot {
                    "morning" | "afternoon" => ["sight", "walk"].contains(&kind),
                    "breakfast" | "lunch" | "dinner" => kind == "food",
                    "transport" => ["flight", "train", "taxi", "walk"].contains(&kind),
                    "stay" => kind == "hotel",
                    "alternative" => true,
                    _ => false,
                };
                if !compatible {
                    return Err("slot and kind mismatch".into());
                }
            }
            for k in ["note", "recommendation"] {
                text(e, k, 5000, false)?;
            }
            for k in ["fullName", "address", "stayLabel"] {
                text(e, k, 500, false)?;
            }
            if let Some(u) = text(e, "sourceUrl", 500, false)?
                && !u.is_empty()
            {
                let parsed = url::Url::parse(u).map_err(|_| "invalid sourceUrl")?;
                if parsed.scheme() != "https"
                    || parsed.host_str().is_none()
                    || !parsed.username().is_empty()
                    || parsed.password().is_some()
                {
                    return Err("sourceUrl must use HTTPS".into());
                }
            }
            if let Some(dest) = e.get("to") {
                if !coord(dest, "lat", 90.) || !coord(dest, "lng", 180.) {
                    return Err("invalid destination coordinates".into());
                }
                text(dest, "name", 300, true)?;
            }
            for k in ["checkInDate", "checkOutDate"] {
                if text(e, k, 10, false)?.is_some_and(|s| date(s).is_none()) {
                    return Err("invalid stay date".into());
                }
            }
            if let Some(n) = e.get("nights")
                && !n.as_u64().is_some_and(|n| n <= 60)
            {
                return Err("invalid nights".into());
            }
            if let Some(a) = e.get("alternative")
                && !a.is_boolean()
            {
                return Err("invalid alternative".into());
            }
        }
    }
    validate_items(&t.packing.extra_items)?;
    if let Some(items) = &t.packing.base_items {
        validate_items(items)?;
        let base: HashSet<_> = items.iter().map(|i| &i.id).collect();
        if t.packing.extra_items.iter().any(|i| base.contains(&i.id)) {
            return Err("duplicate packing id".into());
        }
    }
    if t.packing
        .base_notes
        .as_ref()
        .is_some_and(|s| !bounded(s, 10000, false))
    {
        return Err("invalid baseNotes".into());
    }
    if !unique_ids(&t.packing.checked_ids)
        || !unique_ids(&t.packing.hidden_base_ids)
        || !bounded(&t.packing.notes, 10000, false)
    {
        return Err("invalid packing".into());
    }
    Ok(())
}
