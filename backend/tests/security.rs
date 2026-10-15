use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use tower::ServiceExt;
use travel_backend::{App, Config, now, password_hash, router};
const ORIGIN: &str = "https://travel.test";
fn app() -> App {
    let a = App::new(
        Connection::open_in_memory().unwrap(),
        Config {
            origin: ORIGIN.into(),
            secure_cookie: true,
        },
    )
    .unwrap();
    a.db.lock()
        .unwrap()
        .execute(
            "INSERT INTO users VALUES(1,'admin',?1)",
            [password_hash("safe-test-password").unwrap()],
        )
        .unwrap();
    a
}
#[allow(clippy::too_many_arguments)] // Explicit headers exercise separate authentication boundaries.
async fn call(
    r: &Router,
    method: &str,
    path: &str,
    body: Value,
    cookie: Option<&str>,
    csrf: Option<&str>,
    origin: Option<&str>,
    ip: &str,
) -> (StatusCode, Value, Option<String>) {
    let mut b = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("x-real-ip", ip);
    if let Some(c) = cookie {
        b = b.header("cookie", c);
    }
    if let Some(c) = csrf {
        b = b.header("x-csrf-token", c);
    }
    if let Some(o) = origin {
        b = b.header("origin", o);
    }
    let res = r
        .clone()
        .oneshot(
            b.body(Body::from(if method == "GET" {
                String::new()
            } else {
                body.to_string()
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let cookie = res
        .headers()
        .get("set-cookie")
        .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string());
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let v = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, v, cookie)
}
async fn login(r: &Router) -> (String, String) {
    let (s, v, c) = call(
        r,
        "POST",
        "/api/login",
        json!({"username":"admin","password":"safe-test-password"}),
        None,
        None,
        Some(ORIGIN),
        "1.1.1.1",
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    (c.unwrap(), v["csrfToken"].as_str().unwrap().into())
}
#[tokio::test]
async fn protection_crud_conflicts_and_template() {
    let a = app();
    let r = router(a.clone());
    for p in ["/api/trips", "/api/packing-template"] {
        assert_eq!(
            call(&r, "GET", p, Value::Null, None, None, None, "1.1.1.1")
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        call(
            &r,
            "POST",
            "/api/login",
            json!({"username":"admin","password":"safe-test-password"}),
            None,
            None,
            None,
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (c, csrf) = login(&r).await;
    let (_, list, _) = call(
        &r,
        "GET",
        "/api/trips",
        Value::Null,
        Some(&c),
        None,
        None,
        "1.1.1.1",
    )
    .await;
    let id = list["trips"][0]["id"].as_str().unwrap();
    let (_, mut t, _) = call(
        &r,
        "GET",
        &format!("/api/trips/{id}"),
        Value::Null,
        Some(&c),
        None,
        None,
        "1.1.1.1",
    )
    .await;
    t.as_object_mut().unwrap().remove("id");
    t.as_object_mut().unwrap().remove("updatedAt");
    t["name"] = json!("Private '); DROP TABLE trips; --");
    assert_eq!(
        call(
            &r,
            "POST",
            "/api/trips",
            t.clone(),
            Some(&c),
            None,
            Some(ORIGIN),
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &r,
            "POST",
            "/api/trips",
            t.clone(),
            Some(&c),
            Some(&csrf),
            Some("https://evil.test"),
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (s, created, _) = call(
        &r,
        "POST",
        "/api/trips",
        t.clone(),
        Some(&c),
        Some(&csrf),
        Some(ORIGIN),
        "1.1.1.1",
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{created}");
    let path = format!("/api/trips/{}", created["id"].as_str().unwrap());
    let (s, saved, _) = call(
        &r,
        "PUT",
        &path,
        t.clone(),
        Some(&c),
        Some(&csrf),
        Some(ORIGIN),
        "1.1.1.1",
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(saved["version"], 2);
    assert_eq!(
        call(
            &r,
            "PUT",
            &path,
            t.clone(),
            Some(&c),
            Some(&csrf),
            Some(ORIGIN),
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    t["days"][0]["events"][0]["lat"] = json!(91);
    assert_eq!(
        call(
            &r,
            "PUT",
            &path,
            t,
            Some(&c),
            Some(&csrf),
            Some(ORIGIN),
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (_, template, _) = call(
        &r,
        "GET",
        "/api/packing-template",
        Value::Null,
        Some(&c),
        None,
        None,
        "1.1.1.1",
    )
    .await;
    assert_eq!(
        call(
            &r,
            "PUT",
            "/api/packing-template",
            template.clone(),
            Some(&c),
            Some(&csrf),
            Some(ORIGIN),
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &r,
            "PUT",
            "/api/packing-template",
            template,
            Some(&c),
            Some(&csrf),
            Some(ORIGIN),
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &r,
            "DELETE",
            &path,
            json!({"version":1}),
            Some(&c),
            Some(&csrf),
            Some(ORIGIN),
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &r,
            "DELETE",
            &path,
            json!({"version":2}),
            Some(&c),
            Some(&csrf),
            Some(ORIGIN),
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(
            &r,
            "GET",
            &path,
            Value::Null,
            Some(&c),
            None,
            None,
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let raw: String =
        a.db.lock()
            .unwrap()
            .query_row("SELECT token_hash FROM sessions LIMIT 1", [], |r| r.get(0))
            .unwrap();
    assert!(!c.contains(&raw));
}
#[tokio::test]
async fn lockout_is_global_account_and_ip_persistent() {
    let a = app();
    let r = router(a.clone());
    for i in 0..5 {
        let (s, _, _) = call(
            &r,
            "POST",
            "/api/login",
            json!({"username":format!("unknown-{i}"),"password":"bad"}),
            None,
            None,
            Some(ORIGIN),
            "8.8.8.8",
        )
        .await;
        assert_eq!(
            s,
            if i == 4 {
                StatusCode::TOO_MANY_REQUESTS
            } else {
                StatusCode::UNAUTHORIZED
            }
        );
    }
    let r = router(a.clone());
    assert_eq!(
        call(
            &r,
            "POST",
            "/api/login",
            json!({"username":"admin","password":"safe-test-password"}),
            None,
            None,
            Some(ORIGIN),
            "9.9.9.9"
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    a.db.lock()
        .unwrap()
        .execute("DELETE FROM auth_attempts WHERE key='account'", [])
        .unwrap();
    assert_eq!(
        call(
            &r,
            "POST",
            "/api/login",
            json!({"username":"admin","password":"safe-test-password"}),
            None,
            None,
            Some(ORIGIN),
            "8.8.8.8"
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    a.db.lock()
        .unwrap()
        .execute(
            "UPDATE auth_attempts SET window_start=?1,locked_until=?1",
            [now() - 901],
        )
        .unwrap();
    let (s, _, _) = call(
        &r,
        "POST",
        "/api/login",
        json!({"username":"admin","password":"safe-test-password"}),
        None,
        None,
        Some(ORIGIN),
        "8.8.8.8",
    )
    .await;
    assert_eq!(s, StatusCode::OK);
}
#[tokio::test]
async fn session_expiry_logout_password_rotation() {
    let a = app();
    let r = router(a.clone());
    let (c, csrf) = login(&r).await;
    let (other, _) = login(&r).await;
    let (s, v, new) = call(
        &r,
        "POST",
        "/api/password",
        json!({"currentPassword":"safe-test-password","newPassword":"changed-test-password"}),
        Some(&c),
        Some(&csrf),
        Some(ORIGIN),
        "1.1.1.1",
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let new = new.unwrap();
    assert_ne!(new, c);
    for old in [&c, &other] {
        assert_eq!(
            call(
                &r,
                "GET",
                "/api/trips",
                Value::Null,
                Some(old),
                None,
                None,
                "1.1.1.1"
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        call(
            &r,
            "POST",
            "/api/logout",
            Value::Null,
            Some(&new),
            Some(v["csrfToken"].as_str().unwrap()),
            Some(ORIGIN),
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(
            &r,
            "GET",
            "/api/trips",
            Value::Null,
            Some(&new),
            None,
            None,
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    a.db.lock()
        .unwrap()
        .execute(
            "UPDATE users SET password_hash=?1",
            [password_hash("safe-test-password").unwrap()],
        )
        .unwrap();
    let (c, _) = login(&r).await;
    a.db.lock()
        .unwrap()
        .execute("UPDATE sessions SET last_seen=?1", [now() - 6 * 86400])
        .unwrap();
    assert_eq!(
        call(
            &r,
            "GET",
            "/api/trips",
            Value::Null,
            Some(&c),
            None,
            None,
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::OK
    );
    let (c, _) = login(&r).await;
    a.db.lock()
        .unwrap()
        .execute(
            "UPDATE sessions SET created_at=?1",
            params![now() - 30 * 86400],
        )
        .unwrap();
    assert_eq!(
        call(
            &r,
            "GET",
            "/api/trips",
            Value::Null,
            Some(&c),
            None,
            None,
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}
#[tokio::test]
async fn body_limit_rate_limit_and_json_errors() {
    let r = router(app());
    let (c, csrf) = login(&r).await;
    let req = Request::builder()
        .method("POST")
        .uri("/api/trips")
        .header("content-type", "application/json")
        .header("origin", ORIGIN)
        .header("cookie", c)
        .header("x-csrf-token", csrf)
        .body(Body::from("x".repeat(1024 * 1024 + 1)))
        .unwrap();
    let res = r.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let v: Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert!(v["error"].is_string());
    for _ in 0..120 {
        let _ = call(
            &r,
            "GET",
            "/api/health",
            Value::Null,
            None,
            None,
            None,
            "2.2.2.2",
        )
        .await;
    }
    assert_eq!(
        call(
            &r,
            "GET",
            "/api/health",
            Value::Null,
            None,
            None,
            None,
            "2.2.2.2"
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
}
#[test]
fn invalid_unicode_dates_and_fields_never_panic() {
    let a = app();
    let c = a.db.lock().unwrap();
    let raw: String = c
        .query_row("SELECT body FROM trips LIMIT 1", [], |r| r.get(0))
        .unwrap();
    let mut t: travel_backend::model::Trip = serde_json::from_str(&raw).unwrap();
    t.input.start_date = "界界界x".into();
    assert!(travel_backend::model::validate_trip(&t.input).is_err());
}

#[tokio::test]
async fn snapshot_isolation_and_durable_restart() {
    let path = std::env::temp_dir().join(format!("travel-test-{}.db", uuid::Uuid::new_v4()));
    let a = App::new(
        Connection::open(&path).unwrap(),
        Config {
            origin: ORIGIN.into(),
            secure_cookie: true,
        },
    )
    .unwrap();
    a.db.lock()
        .unwrap()
        .execute(
            "INSERT INTO users VALUES(1,'admin',?1)",
            [password_hash("safe-test-password").unwrap()],
        )
        .unwrap();
    let r = router(a.clone());
    let (c, csrf) = login(&r).await;
    let (_, list, _) = call(
        &r,
        "GET",
        "/api/trips",
        Value::Null,
        Some(&c),
        None,
        None,
        "1.1.1.1",
    )
    .await;
    let id = list["trips"][0]["id"].as_str().unwrap();
    let path_api = format!("/api/trips/{id}");
    let (_, old, _) = call(
        &r,
        "GET",
        &path_api,
        Value::Null,
        Some(&c),
        None,
        None,
        "1.1.1.1",
    )
    .await;
    let (_, mut template, _) = call(
        &r,
        "GET",
        "/api/packing-template",
        Value::Null,
        Some(&c),
        None,
        None,
        "1.1.1.1",
    )
    .await;
    template["items"][0]["label"] = json!("Changed future template");
    assert_eq!(
        call(
            &r,
            "PUT",
            "/api/packing-template",
            template,
            Some(&c),
            Some(&csrf),
            Some(ORIGIN),
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, still_old, _) = call(
        &r,
        "GET",
        &path_api,
        Value::Null,
        Some(&c),
        None,
        None,
        "1.1.1.1",
    )
    .await;
    assert_eq!(
        old["packing"]["baseItems"],
        still_old["packing"]["baseItems"]
    );
    let mut input = old.clone();
    input.as_object_mut().unwrap().remove("id");
    input.as_object_mut().unwrap().remove("updatedAt");
    input["packing"]
        .as_object_mut()
        .unwrap()
        .remove("baseItems");
    input["packing"]
        .as_object_mut()
        .unwrap()
        .remove("baseNotes");
    let (s, new, _) = call(
        &r,
        "POST",
        "/api/trips",
        input,
        Some(&c),
        Some(&csrf),
        Some(ORIGIN),
        "1.1.1.1",
    )
    .await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(
        new["packing"]["baseItems"][0]["label"],
        "Changed future template"
    );
    a.db.lock()
        .unwrap()
        .execute("DELETE FROM trips", [])
        .unwrap();
    for _ in 0..5 {
        let _ = call(
            &r,
            "POST",
            "/api/login",
            json!({"username":"random","password":"bad"}),
            None,
            None,
            Some(ORIGIN),
            "8.8.8.8",
        )
        .await;
    }
    drop(r);
    drop(a);
    let restarted = App::new(
        Connection::open(&path).unwrap(),
        Config {
            origin: ORIGIN.into(),
            secure_cookie: true,
        },
    )
    .unwrap();
    assert_eq!(
        restarted
            .db
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM trips", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        call(
            &router(restarted.clone()),
            "POST",
            "/api/login",
            json!({"username":"admin","password":"safe-test-password"}),
            None,
            None,
            Some(ORIGIN),
            "9.9.9.9"
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    drop(restarted);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn validation_rejects_date_duplicates_mismatched_slots_and_unsafe_urls() {
    let a = app();
    let raw: String =
        a.db.lock()
            .unwrap()
            .query_row("SELECT body FROM trips LIMIT 1", [], |r| r.get(0))
            .unwrap();
    let original: travel_backend::model::Trip = serde_json::from_str(&raw).unwrap();
    for (field, value) in [
        ("lat", json!(-91)),
        ("lng", json!(181)),
        ("time", json!("25:10")),
        ("sourceUrl", json!("javascript:alert(1)")),
        ("slot", json!("dinner")),
    ] {
        let mut t = original.input.clone();
        t.days[0]["events"][0][field] = value;
        assert!(travel_backend::model::validate_trip(&t).is_err(), "{field}");
    }
    let mut t = original.input.clone();
    t.days[1]["id"] = t.days[0]["id"].clone();
    assert!(travel_backend::model::validate_trip(&t).is_err());
    let mut t = original.input.clone();
    t.days[1]["date"] = json!("2026-10-14");
    assert!(travel_backend::model::validate_trip(&t).is_err());
    let mut t = original.input;
    t.start_date = "2026-02-30".into();
    assert!(travel_backend::model::validate_trip(&t).is_err());
}

#[test]
fn breakfast_backup_accepts_food_and_rejects_sights() {
    let a = app();
    let raw: String =
        a.db.lock()
            .unwrap()
            .query_row("SELECT body FROM trips LIMIT 1", [], |r| r.get(0))
            .unwrap();
    let original: travel_backend::model::Trip = serde_json::from_str(&raw).unwrap();
    let mut t = original.input;
    let event = t.days[0]["events"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|e| e["kind"] == "food")
        .unwrap();
    event["slot"] = json!("breakfast");
    event["alternative"] = json!(true);
    assert!(travel_backend::model::validate_trip(&t).is_ok());
    let event = t.days[0]["events"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|e| e["slot"] == "breakfast")
        .unwrap();
    event["kind"] = json!("sight");
    assert!(travel_backend::model::validate_trip(&t).is_err());
}

async fn configure_friend(r: &Router, admin: &str, csrf: &str, name: &str, code: &str) -> Value {
    let (_, records, _) = call(
        r,
        "GET",
        "/api/invites",
        Value::Null,
        Some(admin),
        None,
        None,
        "1.1.1.1",
    )
    .await;
    let record = records["invites"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["name"] == name)
        .unwrap();
    assert_eq!(record["enabled"], false);
    assert_eq!(record["hasCode"], false);
    let path = format!("/api/invites/{}", record["id"].as_str().unwrap());
    let (s, v, _) = call(
        r,
        "PUT",
        &path,
        json!({"name":name,"enabled":true,"code":code,"version":record["version"]}),
        Some(admin),
        Some(csrf),
        Some(ORIGIN),
        "1.1.1.1",
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert!(!v.to_string().contains(code));
    assert!(v.get("code").is_none() && v.get("codeHash").is_none());
    v
}
async fn friend_login(r: &Router, name: &str, code: &str, ip: &str) -> (String, String) {
    let (s, v, c) = call(
        r,
        "POST",
        "/api/invite-login",
        json!({"name":name,"code":code}),
        None,
        None,
        Some(ORIGIN),
        ip,
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["role"], "friend");
    (c.unwrap(), v["csrfToken"].as_str().unwrap().into())
}
#[tokio::test]
async fn friends_own_trips_templates_and_credentials_are_isolated() {
    let a = app();
    let r = router(a.clone());
    let (admin, csrf) = login(&r).await;
    let (_, adminlist, _) = call(
        &r,
        "GET",
        "/api/trips",
        Value::Null,
        Some(&admin),
        None,
        None,
        "1.1.1.1",
    )
    .await;
    let adminid = adminlist["trips"][0]["id"].as_str().unwrap();
    configure_friend(&r, &admin, &csrf, "DemoAlice", "river-forest-train").await;
    configure_friend(&r, &admin, &csrf, "DemoBob", "garden-sun-cloud").await;
    let (demo_alice, mc) =
        friend_login(&r, " ＤＥＭＯＡＬＩＣＥ ", "river-forest-train", "2.2.2.2").await;
    let (demo_bob, nc) = friend_login(&r, "demobob", "garden-sun-cloud", "3.3.3.3").await;
    let (_, ml, _) = call(
        &r,
        "GET",
        "/api/trips",
        Value::Null,
        Some(&demo_alice),
        None,
        None,
        "2.2.2.2",
    )
    .await;
    let (_, nl, _) = call(
        &r,
        "GET",
        "/api/trips",
        Value::Null,
        Some(&demo_bob),
        None,
        None,
        "3.3.3.3",
    )
    .await;
    let mid = ml["trips"][0]["id"].as_str().unwrap();
    let nid = nl["trips"][0]["id"].as_str().unwrap();
    assert_ne!(mid, nid);
    assert_ne!(mid, adminid);
    let path = format!("/api/trips/{mid}");
    let (_, mut trip, _) = call(
        &r,
        "GET",
        &path,
        Value::Null,
        Some(&demo_alice),
        None,
        None,
        "2.2.2.2",
    )
    .await;
    trip.as_object_mut().unwrap().remove("id");
    trip.as_object_mut().unwrap().remove("updatedAt");
    trip["name"] = json!("DemoAlice's private edit");
    for outsider in [&demo_bob, &admin] {
        assert_eq!(
            call(
                &r,
                "GET",
                &path,
                Value::Null,
                Some(outsider),
                None,
                None,
                "4.4.4.4"
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        call(
            &r,
            "PUT",
            &path,
            trip.clone(),
            Some(&demo_bob),
            Some(&nc),
            Some(ORIGIN),
            "3.3.3.3"
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &r,
            "DELETE",
            &path,
            json!({"version":1}),
            Some(&demo_bob),
            Some(&nc),
            Some(ORIGIN),
            "3.3.3.3"
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &r,
            "PUT",
            &path,
            trip,
            Some(&demo_alice),
            Some(&mc),
            Some(ORIGIN),
            "2.2.2.2"
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &r,
            "GET",
            "/api/invites",
            Value::Null,
            Some(&demo_alice),
            None,
            None,
            "2.2.2.2"
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (_, mut template, _) = call(
        &r,
        "GET",
        "/api/packing-template",
        Value::Null,
        Some(&demo_alice),
        None,
        None,
        "2.2.2.2",
    )
    .await;
    template["notes"] = json!("private packing notes");
    assert_eq!(
        call(
            &r,
            "PUT",
            "/api/packing-template",
            template,
            Some(&demo_alice),
            Some(&mc),
            Some(ORIGIN),
            "2.2.2.2"
        )
        .await
        .0,
        StatusCode::OK
    );
    for outsider in [&demo_bob, &admin] {
        let (_, v, _) = call(
            &r,
            "GET",
            "/api/packing-template",
            Value::Null,
            Some(outsider),
            None,
            None,
            "4.4.4.4",
        )
        .await;
        assert_ne!(v["notes"], "private packing notes");
    }
    let (s, session, newcookie) = call(
        &r,
        "POST",
        "/api/password",
        json!({"currentPassword":"river-forest-train","newPassword":"changed-demo_alice-code"}),
        Some(&demo_alice),
        Some(&mc),
        Some(ORIGIN),
        "2.2.2.2",
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(session["role"], "friend");
    let newcookie = newcookie.unwrap();
    assert_eq!(
        call(
            &r,
            "GET",
            "/api/trips",
            Value::Null,
            Some(&demo_alice),
            None,
            None,
            "2.2.2.2"
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    for other in [&demo_bob, &admin] {
        assert_eq!(
            call(
                &r,
                "GET",
                "/api/trips",
                Value::Null,
                Some(other),
                None,
                None,
                "4.4.4.4"
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    assert_eq!(
        call(
            &r,
            "DELETE",
            &path,
            json!({"version":2}),
            Some(&newcookie),
            Some(session["csrfToken"].as_str().unwrap()),
            Some(ORIGIN),
            "2.2.2.2"
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let (again, _) = friend_login(&r, "DemoAlice", "changed-demo_alice-code", "2.2.2.2").await;
    let (_, empty, _) = call(
        &r,
        "GET",
        "/api/trips",
        Value::Null,
        Some(&again),
        None,
        None,
        "2.2.2.2",
    )
    .await;
    assert!(empty["trips"].as_array().unwrap().is_empty());
    let (_, still_admin, _) = call(
        &r,
        "GET",
        "/api/trips",
        Value::Null,
        Some(&admin),
        None,
        None,
        "1.1.1.1",
    )
    .await;
    assert_eq!(still_admin, adminlist);
    let raw: String =
        a.db.lock()
            .unwrap()
            .query_row(
                "SELECT code_hash FROM invites WHERE name='DemoAlice'",
                [],
                |r| r.get(0),
            )
            .unwrap();
    assert!(raw.starts_with("$argon2id$"));
    assert!(!raw.contains("changed-demo_alice-code"));
}
#[tokio::test]
async fn friend_lockout_revocation_normalized_names_do_not_lock_admin() {
    let a = app();
    let r = router(a.clone());
    let (admin, csrf) = login(&r).await;
    for i in 0..5 {
        let (s, _, _) = call(
            &r,
            "POST",
            "/api/invite-login",
            json!({"name":format!("unknown-{i}"),"code":"bad"}),
            None,
            None,
            Some(ORIGIN),
            "8.8.8.8",
        )
        .await;
        assert_eq!(
            s,
            if i == 4 {
                StatusCode::TOO_MANY_REQUESTS
            } else {
                StatusCode::UNAUTHORIZED
            }
        );
    }
    assert_eq!(
        call(
            &r,
            "POST",
            "/api/login",
            json!({"username":"admin","password":"safe-test-password"}),
            None,
            None,
            Some(ORIGIN),
            "8.8.8.8"
        )
        .await
        .0,
        StatusCode::OK
    );
    let mut record = configure_friend(&r, &admin, &csrf, "DemoAlice", "river-forest-train").await;
    assert_eq!(
        call(
            &r,
            "POST",
            "/api/invites",
            json!({"name":"  ＤＥＭＯＡＬＩＣＥ  ","enabled":false}),
            Some(&admin),
            Some(&csrf),
            Some(ORIGIN),
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (cookie, _) = friend_login(&r, "DemoAlice", "river-forest-train", "2.2.2.2").await;
    let path = format!("/api/invites/{}", record["id"].as_str().unwrap());
    let (s, v, _) = call(
        &r,
        "PUT",
        &path,
        json!({"name":"DemoAlice","enabled":false,"version":record["version"]}),
        Some(&admin),
        Some(&csrf),
        Some(ORIGIN),
        "1.1.1.1",
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    record = v;
    assert_eq!(
        call(
            &r,
            "GET",
            "/api/trips",
            Value::Null,
            Some(&cookie),
            None,
            None,
            "2.2.2.2"
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &r,
            "POST",
            "/api/invite-login",
            json!({"name":"DemoAlice","code":"river-forest-train"}),
            None,
            None,
            Some(ORIGIN),
            "2.2.2.2"
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &r,
            "PUT",
            &path,
            json!({"name":"DemoAlice","enabled":true,"version":1}),
            Some(&admin),
            Some(&csrf),
            Some(ORIGIN),
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &r,
            "PUT",
            &path,
            json!({"name":"DemoAlice","enabled":true,"version":record["version"]}),
            Some(&admin),
            Some(&csrf),
            Some(ORIGIN),
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::OK
    );
    for i in 0..5 {
        let (s, _, _) = call(
            &r,
            "POST",
            "/api/invite-login",
            json!({"name":"DemoAlice","code":"wrong"}),
            None,
            None,
            Some(ORIGIN),
            &format!("9.9.9.{}", i + 1),
        )
        .await;
        assert_eq!(
            s,
            if i == 4 {
                StatusCode::TOO_MANY_REQUESTS
            } else {
                StatusCode::UNAUTHORIZED
            }
        );
    }
    assert_eq!(
        call(
            &router(a.clone()),
            "POST",
            "/api/invite-login",
            json!({"name":"DemoAlice","code":"river-forest-train"}),
            None,
            None,
            Some(ORIGIN),
            "10.10.10.10"
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        a.db.lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM auth_attempts WHERE key='account'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}
#[test]
fn schema1_migration_preserves_admin_trips_template_sessions() {
    use sha2::{Digest, Sha256};
    let fresh = app();
    let body: String = fresh
        .db
        .lock()
        .unwrap()
        .query_row("SELECT body FROM trips LIMIT 1", [], |r| r.get(0))
        .unwrap();
    let id: Value = serde_json::from_str(&body).unwrap();
    let old = Connection::open_in_memory().unwrap();
    old.execute_batch("CREATE TABLE users(id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL,password_hash TEXT NOT NULL);CREATE TABLE trips(id TEXT PRIMARY KEY,body TEXT NOT NULL,version INTEGER NOT NULL,updated_at INTEGER NOT NULL);CREATE TABLE packing_template(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL,version INTEGER NOT NULL);CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,created_at INTEGER NOT NULL,last_seen INTEGER NOT NULL);CREATE TABLE auth_attempts(key TEXT PRIMARY KEY,failures INTEGER NOT NULL,window_start INTEGER NOT NULL,locked_until INTEGER NOT NULL);CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO metadata VALUES('seeded','1');PRAGMA user_version=1;").unwrap();
    old.execute(
        "INSERT INTO users VALUES(1,'admin',?1)",
        [password_hash("safe-test-password").unwrap()],
    )
    .unwrap();
    old.execute(
        "INSERT INTO trips VALUES(?1,?2,1,?3)",
        params![id["id"].as_str().unwrap(), body, now()],
    )
    .unwrap();
    old.execute(
        "INSERT INTO packing_template VALUES(1,?1,7)",
        [json!({"items":[],"notes":"existing private notes","version":7}).to_string()],
    )
    .unwrap();
    old.execute(
        "INSERT INTO sessions VALUES(?1,'csrf-existing',?2,?2)",
        params![
            format!("{:x}", Sha256::digest("a".repeat(64).as_bytes())),
            now()
        ],
    )
    .unwrap();
    let migrated = App::new(
        old,
        Config {
            origin: ORIGIN.into(),
            secure_cookie: true,
        },
    )
    .unwrap();
    let c = migrated.db.lock().unwrap();
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM trips WHERE owner_id='admin'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        c.query_row("SELECT body FROM trips", [], |r| r.get::<_, String>(0))
            .unwrap(),
        body
    );
    assert!(
        c.query_row(
            "SELECT body FROM packing_template WHERE owner_id='admin'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap()
        .contains("existing private notes")
    );
    assert_eq!(
        c.query_row("SELECT account_id FROM sessions", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "admin"
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM invites WHERE enabled=0 AND code_hash IS NULL",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
}

#[test]
fn activity_types_keep_legacy_and_coordinate_boundaries() {
    let mut trip: travel_backend::model::TripInput = serde_json::from_value(json!({
        "name":"Type and location test","destination":"德国","startDate":"2026-10-12",
        "endDate":"2026-10-12","timezone":"Europe/Berlin","days":[{
            "id":"day-one","date":"2026-10-12","city":"","title":"","events":[{
                "id":"event-one","title":"A place","kind":"visit","slot":"morning",
                "lat":0,"lng":0,"note":""
            }]
        }],"packing":{"extraItems":[],"checkedIds":[],"hiddenBaseIds":[],"notes":""}
    }))
    .unwrap();
    for kind in ["nature", "visit", "shopping", "activity", "sight", "walk"] {
        for slot in ["morning", "afternoon"] {
            trip.days[0]["events"][0]["kind"] = json!(kind);
            trip.days[0]["events"][0]["slot"] = json!(slot);
            assert!(
                travel_backend::model::validate_trip(&trip).is_ok(),
                "{kind}/{slot}"
            );
        }
    }
    trip.days[0]["events"][0]["kind"] = json!("nature");
    trip.days[0]["events"][0]["slot"] = json!("transport");
    assert!(travel_backend::model::validate_trip(&trip).is_err());
    trip.days[0]["events"][0]["slot"] = json!("morning");
    for (lat, lng, accepted) in [
        (90., 180., true),
        (-90., -180., true),
        (90.001, 0., false),
        (0., -180.001, false),
    ] {
        trip.days[0]["events"][0]["lat"] = json!(lat);
        trip.days[0]["events"][0]["lng"] = json!(lng);
        assert_eq!(
            travel_backend::model::validate_trip(&trip).is_ok(),
            accepted
        );
    }
}

#[tokio::test]
async fn weather_requires_session_and_ownership_and_handles_unforecastable_days() {
    let a = app();
    let r = router(a.clone());
    let (cookie, _) = login(&r).await;
    let (id, mut body): (String, Value) = {
        let db = a.db.lock().unwrap();
        let (id, raw): (String, String) = db
            .query_row(
                "SELECT id,body FROM trips WHERE owner_id='admin' LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        (id, serde_json::from_str(&raw).unwrap())
    };
    let day_id = body["days"][0]["id"].as_str().unwrap().to_owned();
    let path = format!("/api/trips/{id}/weather/{day_id}");
    assert_eq!(
        call(&r, "GET", &path, Value::Null, None, None, None, "1.1.1.1")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    // A known trip id belonging to a different account must remain inaccessible.
    a.db.lock()
        .unwrap()
        .execute("UPDATE trips SET owner_id='other' WHERE id=?1", [&id])
        .unwrap();
    assert_eq!(
        call(
            &r,
            "GET",
            &path,
            Value::Null,
            Some(&cookie),
            None,
            None,
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    a.db.lock()
        .unwrap()
        .execute("UPDATE trips SET owner_id='admin' WHERE id=?1", [&id])
        .unwrap();
    body["days"][0]["date"] = json!("2100-01-01");
    a.db.lock()
        .unwrap()
        .execute(
            "UPDATE trips SET body=?1 WHERE id=?2",
            params![body.to_string(), id],
        )
        .unwrap();
    let (status, value, _) = call(
        &r,
        "GET",
        &path,
        Value::Null,
        Some(&cookie),
        None,
        None,
        "1.1.1.1",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["status"], "future");
    body["days"][0]["date"] = json!("2000-01-01");
    a.db.lock()
        .unwrap()
        .execute(
            "UPDATE trips SET body=?1 WHERE id=?2",
            params![body.to_string(), id],
        )
        .unwrap();
    assert_eq!(
        call(
            &r,
            "GET",
            &path,
            Value::Null,
            Some(&cookie),
            None,
            None,
            "1.1.1.1"
        )
        .await
        .1["status"],
        "past"
    );
    body["days"][0]["events"] = json!([]);
    a.db.lock()
        .unwrap()
        .execute(
            "UPDATE trips SET body=?1 WHERE id=?2",
            params![body.to_string(), id],
        )
        .unwrap();
    assert_eq!(
        call(
            &r,
            "GET",
            &path,
            Value::Null,
            Some(&cookie),
            None,
            None,
            "1.1.1.1"
        )
        .await
        .1["status"],
        "no-location"
    );
    assert_eq!(
        call(
            &r,
            "GET",
            &format!("/api/trips/{id}/weather/missing"),
            Value::Null,
            Some(&cookie),
            None,
            None,
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn map_link_import_requires_login_csrf_and_a_known_map_host() {
    let a = app();
    let r = router(a);
    let path = "/api/map-links/resolve";
    let body = json!({"url":"https://surl.amap.com/example"});
    assert_eq!(
        call(
            &r,
            "POST",
            path,
            body.clone(),
            None,
            None,
            Some(ORIGIN),
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (cookie, csrf) = login(&r).await;
    assert_eq!(
        call(
            &r,
            "POST",
            path,
            body,
            Some(&cookie),
            None,
            Some(ORIGIN),
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &r,
            "POST",
            path,
            json!({"url":"https://maps.apple.com.evil.test/"}),
            Some(&cookie),
            Some(&csrf),
            Some(ORIGIN),
            "1.1.1.1"
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn idle_sessions_survive_both_login_cleanup_paths() {
    let a = app();
    let r = router(a.clone());
    let (admin, csrf) = login(&r).await;
    configure_friend(&r, &admin, &csrf, "DemoAlice", "river-forest-train").await;
    let (friend, _) = friend_login(&r, "DemoAlice", "river-forest-train", "2.2.2.2").await;
    let created = now() - 29 * 86400;
    a.db.lock()
        .unwrap()
        .execute("UPDATE sessions SET created_at=?1,last_seen=?1", [created])
        .unwrap();
    // Logging in must only purge absolute expiry, including sessions of the other account.
    login(&r).await;
    friend_login(&r, "DemoAlice", "river-forest-train", "2.2.2.2").await;
    for cookie in [&admin, &friend] {
        let (status, _, new_cookie) = call(
            &r,
            "GET",
            "/api/trips",
            Value::Null,
            Some(cookie),
            None,
            None,
            "1.1.1.1",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(new_cookie.is_none(), "activity must not refresh the cookie");
    }
    let count: i64 =
        a.db.lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE created_at=?1",
                [created],
                |row| row.get(0),
            )
            .unwrap();
    assert_eq!(
        count, 2,
        "activity must not extend either account's creation timestamp"
    );
}

#[tokio::test]
async fn login_cookie_has_fixed_thirty_day_lifetime() {
    let r = router(app());
    let response = r
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/login")
                .header("content-type", "application/json")
                .header("origin", ORIGIN)
                .header("x-real-ip", "1.1.1.1")
                .body(Body::from(
                    json!({"username":"admin","password":"safe-test-password"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(cookie.contains("Max-Age=2592000;"));
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("Secure"));
}
