//! Expand only known map share links. No cookies, credentials, or arbitrary hosts leave the app.
use super::{ApiError, bad, now};
use axum::{Json, http::StatusCode};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{net::IpAddr, process::Stdio, sync::OnceLock, time::Duration};
use tokio::{
    io::AsyncReadExt,
    net::lookup_host,
    process::Command,
    sync::{Mutex, Semaphore},
};
use url::Url;

const HOSTS: &[&str] = &[
    "maps.apple.com",
    "maps.apple",
    "surl.amap.com",
    "uri.amap.com",
    "www.amap.com",
    "amap.com",
    "m.amap.com",
    "wb.amap.com",
];
static SLOTS: Semaphore = Semaphore::const_new(2);
static LIMIT: OnceLock<Mutex<Limits>> = OnceLock::new();
#[derive(Default)]
struct Limits {
    minute: (i64, u32),
    day: (i64, u32),
}
#[derive(Deserialize)]
pub struct Input {
    url: String,
}

fn validated(raw: &str) -> Result<Url, ApiError> {
    if raw.len() > 4096 || raw.chars().any(char::is_control) {
        return Err(bad("地图链接格式不正确"));
    }
    let url = Url::parse(raw).map_err(|_| bad("地图链接格式不正确"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || !url.host_str().is_some_and(|host| HOSTS.contains(&host))
    {
        return Err(bad("仅支持高德或苹果地图的 HTTPS 分享链接"));
    }
    Ok(url)
}
// The share gateway already supplies the selected POI in this URL. Loading its app page
// adds no location data and can trigger unrelated redirects; leave coordinate parsing to the UI.
fn has_amap_point(url: &Url) -> bool {
    url.host_str() == Some("wb.amap.com")
        && url.query_pairs().any(|(key, value)| {
            if key != "p" {
                return false;
            }
            let fields: Vec<_> = value.split(',').take(3).collect();
            fields.len() == 3
                && !fields[0].is_empty()
                && fields[1]
                    .parse::<f64>()
                    .is_ok_and(|v| v.is_finite() && (-90.0..=90.0).contains(&v))
                && fields[2]
                    .parse::<f64>()
                    .is_ok_and(|v| v.is_finite() && (-180.0..=180.0).contains(&v))
        })
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && (b == 168 || b == 0 || (b == 88 && c == 99)))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            // Permit global unicast only; exclude transition and special/documentation ranges.
            (s[0] & 0xe000) == 0x2000
                && s[0] != 0x2002
                && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}
fn unavailable() -> ApiError {
    ApiError(
        StatusCode::BAD_GATEWAY,
        "地图分享链接暂时无法展开，请手动选点或稍后重试".into(),
        None,
    )
}
fn busy(seconds: i64) -> ApiError {
    ApiError(
        StatusCode::TOO_MANY_REQUESTS,
        "地图导入请求较多，请稍后重试".into(),
        Some(seconds),
    )
}

fn response_headers(bytes: &[u8]) -> Result<(u16, Option<String>), ApiError> {
    let text = std::str::from_utf8(bytes).map_err(|_| unavailable())?;
    let block = text
        .rsplit("\r\n\r\n")
        .find(|s| s.starts_with("HTTP/"))
        .ok_or_else(unavailable)?;
    let mut lines = block.split("\r\n");
    let status = lines
        .next()
        .and_then(|s| s.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or_else(unavailable)?;
    let mut location = None;
    for line in lines {
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("location")
        {
            if location.is_some() {
                return Err(unavailable());
            }
            location = Some(value.trim().to_string());
        }
    }
    Ok((status, location))
}
async fn fetch(url: &Url) -> Result<(u16, Option<String>), ApiError> {
    let host = url.host_str().ok_or_else(unavailable)?;
    let addresses: Vec<_> = lookup_host((host, 443))
        .await
        .map_err(|_| unavailable())?
        .map(|a| a.ip())
        .collect();
    if addresses.is_empty() || addresses.iter().any(|ip| !public_ip(*ip)) {
        return Err(unavailable());
    }
    let ip = addresses[0];
    let address = match ip {
        IpAddr::V4(_) => ip.to_string(),
        IpAddr::V6(_) => format!("[{ip}]"),
    };
    let resolve = format!("{host}:443:{address}");
    // Disable curl configuration, environment proxies and automatic redirects. Each hop gets a
    // fresh public DNS check and a pinned address, keeping DNS rebinding outside the trust boundary.
    let mut child = Command::new("curl")
        .args([
            "--disable",
            "--silent",
            "--show-error",
            "--noproxy",
            "*",
            "--proto",
            "=https",
            "--resolve",
            &resolve,
            "--connect-timeout",
            "3",
            "--max-time",
            "5",
            "--max-filesize",
            "262144",
            "--dump-header",
            "-",
            "--output",
            "/dev/null",
            url.as_str(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| unavailable())?;
    let mut bytes = Vec::new();
    child
        .stdout
        .take()
        .ok_or_else(unavailable)?
        .take(16385)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| unavailable())?;
    if bytes.len() > 16384 {
        return Err(unavailable());
    }
    let status = child.wait().await.map_err(|_| unavailable())?;
    // Bodies are deliberately unused. A provider's oversized page is safe to discard.
    if !status.success() && status.code() != Some(63) {
        return Err(unavailable());
    }
    response_headers(&bytes)
}
pub async fn resolve(Json(input): Json<Input>) -> Result<Json<Value>, ApiError> {
    let mut url = validated(input.url.trim())?;
    let _slot = SLOTS.try_acquire().map_err(|_| busy(5))?;
    {
        let n = now();
        let mut limit = LIMIT
            .get_or_init(|| Mutex::new(Limits::default()))
            .lock()
            .await;
        if limit.minute.0 != n / 60 {
            limit.minute = (n / 60, 0);
        }
        if limit.day.0 != n / 86400 {
            limit.day = (n / 86400, 0);
        }
        if limit.minute.1 >= 30 {
            return Err(busy(60 - n % 60));
        }
        if limit.day.1 >= 300 {
            return Err(busy(86400 - n % 86400));
        }
        limit.minute.1 += 1;
        limit.day.1 += 1;
    }
    tokio::time::timeout(Duration::from_secs(12), async {
        for hop in 0..=4 {
            let (status, location) = fetch(&url).await?;
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                if hop == 4 {
                    return Err(bad("地图链接跳转过多，请换用完整地点链接或手动选点"));
                }
                let target = url
                    .join(&location.ok_or_else(unavailable)?)
                    .map_err(|_| unavailable())?;
                url = validated(target.as_str())?;
                if has_amap_point(&url) {
                    return Ok(Json(json!({"url":url.as_str()})));
                }
            } else if (200..300).contains(&status) {
                return Ok(Json(json!({"url":url.as_str()})));
            } else {
                return Err(unavailable());
            }
        }
        Err(unavailable())
    })
    .await
    .map_err(|_| unavailable())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_map_hosts_and_transport() {
        for s in [
            "http://maps.apple.com/?ll=1,2",
            "https://maps.apple.com.evil.test/",
            "https://wb.amap.com.evil.test/",
            "https://user@wb.amap.com/",
            "https://user@maps.apple.com/",
            "https://user:secret@maps.apple.com/",
            "https://maps.apple.com:444/",
            "https://127.0.0.1/",
            "https://maps.apple.com./",
            "https://surl.amap.com/\nfoo",
        ] {
            assert!(validated(s).is_err(), "{s}");
        }
        for s in [
            "https://maps.apple.com/?ll=1,2",
            "https://maps.apple/p/abc",
            "https://surl.amap.com/abc",
            "https://uri.amap.com/marker?position=1,2",
            "https://wb.amap.com/?p=B00150F6D6,31.23970343070824,121.49971783161163",
        ] {
            assert!(validated(s).is_ok(), "{s}");
        }
    }
    #[test]
    fn special_ip_ranges_are_blocked() {
        for s in [
            "0.0.0.0",
            "127.0.0.1",
            "10.1.2.3",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.1.1",
            "100.64.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "2002:7f00:1::",
            "3fff::1",
        ] {
            assert!(!public_ip(s.parse().unwrap()), "{s}");
        }
        for s in [
            "8.8.8.8",
            "1.1.1.1",
            "2001:4860:4860::8888",
            "2606:4700:4700::1111",
        ] {
            assert!(public_ip(s.parse().unwrap()), "{s}");
        }
    }
    #[test]
    fn redirects_are_checked_before_next_request() {
        let base = validated("https://surl.amap.com/abc").unwrap();
        for target in [
            "//127.0.0.1/",
            "https://example.com/",
            "http://maps.apple.com/",
            "https://maps.apple.com:8443/",
            "https://x@maps.apple.com/",
        ] {
            assert!(validated(base.join(target).unwrap().as_str()).is_err());
        }
        assert!(validated(base.join("/next").unwrap().as_str()).is_ok());
    }
    #[test]
    fn read_headers_without_using_body() {
        let (status, location) = response_headers(b"HTTP/1.1 100 Continue\r\n\r\nHTTP/2 302\r\nLocation: https://maps.apple.com/?ll=1,2\r\n\r\n").unwrap();
        assert_eq!(status, 302);
        assert_eq!(location.as_deref(), Some("https://maps.apple.com/?ll=1,2"));
        assert!(response_headers(b"HTTP/2 302\r\nLocation: /a\r\nlocation: /b\r\n\r\n").is_err());
        assert!(response_headers(b"not HTTP").is_err());
    }
    #[tokio::test]
    #[ignore = "requires public Apple Maps network access"]
    async fn live_apple_short_link() {
        let Json(result) = resolve(Json(Input {
            url: "https://maps.apple/p/U8rE9v8n8iVZjr".into(),
        }))
        .await
        .unwrap();
        assert!(
            result["url"]
                .as_str()
                .unwrap()
                .starts_with("https://maps.apple.com/")
        );
        println!("Resolved Apple URL: {}", result["url"]);
    }
    #[test]
    fn amap_point_requires_valid_coordinates() {
        for raw in [
            "https://wb.amap.com/?p=B00150F6D6,31.23970343070824,121.49971783161163",
            "https://wb.amap.com/?p=B00150F6D6%2C31.23970343070824%2C121.49971783161163%2C东方明珠广播电视塔",
        ] {
            assert!(has_amap_point(&validated(raw).unwrap()));
        }
        for raw in [
            "https://wb.amap.com/?p=B00150F6D6",
            "https://wb.amap.com/?p=B00150F6D6,NaN,1",
            "https://wb.amap.com/?p=B00150F6D6,91,1",
            "https://surl.amap.com/?p=B00150F6D6,1,2",
        ] {
            assert!(!has_amap_point(&validated(raw).unwrap()));
        }
    }
    #[tokio::test]
    #[ignore = "requires public Amap network access"]
    async fn live_amap_short_link() {
        let Json(result) = resolve(Json(Input {
            url: "https://surl.amap.com/2b7Uxlw1xf1y".into(),
        }))
        .await
        .unwrap();
        let url = validated(result["url"].as_str().unwrap()).unwrap();
        assert!(has_amap_point(&url));
        let p = url
            .query_pairs()
            .find(|(key, _)| key == "p")
            .unwrap()
            .1
            .into_owned();
        assert!(p.starts_with("B00150F6D6,31.23970343070824,121.49971783161163,"));
        assert!(p.contains("东方明珠"));
        println!("Resolved Amap POI: {p}");
    }
}
