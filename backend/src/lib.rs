mod invites;
mod map_pack;
pub mod model;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use model::{Item, Packing, Template, Trip, TripInput};
use rand::{RngCore, rngs::OsRng};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;

const ABSOLUTE: i64 = 7 * 86400;
const IDLE: i64 = 12 * 3600;
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
pub fn password_hash(s: &str) -> Result<String, String> {
    Argon2::default()
        .hash_password(s.as_bytes(), &SaltString::generate(&mut OsRng))
        .map(|x| x.to_string())
        .map_err(|_| "password hashing failed".into())
}
fn verify(s: &str, h: &str) -> bool {
    PasswordHash::new(h).is_ok_and(|h| Argon2::default().verify_password(s.as_bytes(), &h).is_ok())
}

#[derive(Clone)]
pub struct Config {
    pub origin: String,
    pub secure_cookie: bool,
}
#[derive(Clone)]
pub struct App {
    pub db: Arc<Mutex<Connection>>,
    pub config: Config,
    limits: Arc<Mutex<HashMap<IpAddr, (i64, u32)>>>,
    auth_slots: Arc<Semaphore>,
    db_slots: Arc<Semaphore>,
}
#[derive(Debug)]
pub struct ApiError(StatusCode, String, Option<i64>);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut r = (
            self.0,
            Json(json!({"error":self.1,"retryAfterSeconds":self.2})),
        )
            .into_response();
        r.headers_mut()
            .insert("cache-control", HeaderValue::from_static("no-store"));
        r.headers_mut().insert(
            "x-content-type-options",
            HeaderValue::from_static("nosniff"),
        );
        if let Some(n) = self.2 {
            r.headers_mut().insert(
                "retry-after",
                HeaderValue::from_str(&n.to_string()).unwrap(),
            );
        }
        r
    }
}
fn bad(s: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, s.into(), None)
}
fn unauthorized() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "请先登录".into(), None)
}
fn internal(e: impl std::fmt::Display) -> ApiError {
    eprintln!("travel backend operation failed: {e}");
    ApiError(
        StatusCode::INTERNAL_SERVER_ERROR,
        "服务暂时不可用".into(),
        None,
    )
}
impl App {
    pub fn new(mut conn: Connection, config: Config) -> Result<Self, String> {
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        let schema: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if schema > 2 {
            return Err("database schema is newer than this backend; do not downgrade without a compatible restore".into());
        }
        conn.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
        )
        .map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        if schema < 1 {
            tx.execute_batch("CREATE TABLE users(id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL,password_hash TEXT NOT NULL);
            CREATE TABLE trips(id TEXT PRIMARY KEY,body TEXT NOT NULL,version INTEGER NOT NULL,updated_at INTEGER NOT NULL);
            CREATE TABLE packing_template(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL,version INTEGER NOT NULL);
            CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,created_at INTEGER NOT NULL,last_seen INTEGER NOT NULL);
            CREATE TABLE auth_attempts(key TEXT PRIMARY KEY,failures INTEGER NOT NULL,window_start INTEGER NOT NULL,locked_until INTEGER NOT NULL);").map_err(|e|e.to_string())?;
        }
        if schema < 2 {
            tx.execute_batch("CREATE TABLE invites(id TEXT PRIMARY KEY,name TEXT NOT NULL,normalized_name TEXT NOT NULL UNIQUE,code_hash TEXT,enabled INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,seeded INTEGER NOT NULL DEFAULT 0);
            ALTER TABLE trips ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'admin';
            CREATE INDEX trips_owner_updated ON trips(owner_id,updated_at DESC);
            ALTER TABLE sessions ADD COLUMN account_id TEXT NOT NULL DEFAULT 'admin';
            ALTER TABLE packing_template RENAME TO old_packing_template;
            CREATE TABLE packing_template(owner_id TEXT PRIMARY KEY,body TEXT NOT NULL,version INTEGER NOT NULL);
            INSERT INTO packing_template SELECT 'admin',body,version FROM old_packing_template;
            DROP TABLE old_packing_template;
            PRAGMA user_version=2;").map_err(|e|e.to_string())?;
            for name in ["DemoAlice", "DemoBob"] {
                tx.execute(
                    "INSERT INTO invites(id,name,normalized_name) VALUES(?1,?2,?3)",
                    params![
                        uuid::Uuid::new_v4().to_string(),
                        name,
                        invites::normalize_name(name)
                    ],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        let app = Self {
            db: Arc::new(Mutex::new(conn)),
            config,
            limits: Arc::new(Mutex::new(HashMap::new())),
            auth_slots: Arc::new(Semaphore::new(1)),
            db_slots: Arc::new(Semaphore::new(16)),
        };
        app.seed()?;
        Ok(app)
    }
    fn seed(&self) -> Result<(), String> {
        let mut c = self.db.lock().map_err(|_| "database lock unavailable")?;
        seed_space(&mut c, "admin")
    }
    async fn run<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, ApiError> + Send + 'static,
    ) -> Result<T, ApiError> {
        let permit = self.db_slots.clone().try_acquire_owned().map_err(|_| {
            ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "请求繁忙，请稍后重试".into(),
                Some(2),
            )
        })?;
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || {
            // Keep the permit until the blocking job finishes, including if the HTTP future is cancelled.
            let _permit = permit;
            let mut c = db.lock().map_err(internal)?;
            f(&mut c)
        })
        .await
        .map_err(internal)?
    }
    fn cookie_name(&self) -> &str {
        if self.config.secure_cookie {
            "__Host-travel_session"
        } else {
            "travel_session"
        }
    }
    fn cookie(&self, token: &str, age: i64) -> String {
        format!(
            "{}={}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}{}",
            self.cookie_name(),
            token,
            age,
            if self.config.secure_cookie {
                "; Secure"
            } else {
                ""
            }
        )
    }
}

fn seed_space(c: &mut Connection, owner: &str) -> Result<(), String> {
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let template = Template {
        items: vec![
            Item {
                id: "passport".into(),
                label: "护照 / 身份证件".into(),
                category: "证件".into(),
            },
            Item {
                id: "tickets".into(),
                label: "车票、机票与预订确认".into(),
                category: "证件".into(),
            },
            Item {
                id: "phone".into(),
                label: "手机与充电线".into(),
                category: "电子设备".into(),
            },
            Item {
                id: "clothes".into(),
                label: "换洗衣物".into(),
                category: "衣物".into(),
            },
            Item {
                id: "toiletries".into(),
                label: "个人洗漱用品".into(),
                category: "日用".into(),
            },
        ],
        notes: "出发前核对证件有效期、行李额度与交通预订。".into(),
        version: 1,
    };
    tx.execute(
        "INSERT OR IGNORE INTO packing_template(owner_id,body,version) VALUES(?1,?2,1)",
        params![
            owner,
            serde_json::to_string(&template).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| e.to_string())?;
    // Only seed a genuinely new database: deleting all trips must not resurrect the demo.
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);",
    )
    .map_err(|e| e.to_string())?;
    let exists: bool = if owner == "admin" {
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM metadata WHERE key='seeded')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?
    } else {
        tx.query_row("SELECT seeded FROM invites WHERE id=?1", [owner], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?
    };
    if !exists {
        let days: Vec<Value> = serde_json::from_str(include_str!("../../src/itinerary.json"))
            .map_err(|e| e.to_string())?;
        let input = TripInput {
            name: "德国双人之旅".into(),
            destination: "德国".into(),
            start_date: "2026-10-12".into(),
            end_date: "2026-10-21".into(),
            timezone: "Europe/Berlin".into(),
            days,
            packing: Packing {
                base_items: Some(template.items.clone()),
                base_notes: Some(template.notes.clone()),
                extra_items: vec![
                    Item {
                        id: "de-adapter".into(),
                        label: "欧标转换头".into(),
                        category: "电子设备".into(),
                    },
                    Item {
                        id: "de-jacket".into(),
                        label: "薄外套".into(),
                        category: "衣物".into(),
                    },
                ],
                checked_ids: vec![],
                hidden_base_ids: vec![],
                notes: "演示行程：交通时刻并非真实班次，出发前核对 ICE、航班及行李限制。".into(),
            },
            version: Some(1),
        };
        model::validate_trip(&input).map_err(|e| format!("invalid seed: {e}"))?;
        let trip = Trip {
            id: uuid::Uuid::new_v4().to_string(),
            input,
            updated_at: now(),
        };
        tx.execute(
            "INSERT INTO trips(id,body,version,updated_at,owner_id) VALUES(?1,?2,1,?3,?4)",
            params![
                trip.id,
                serde_json::to_string(&trip).map_err(|e| e.to_string())?,
                trip.updated_at,
                owner
            ],
        )
        .map_err(|e| e.to_string())?;
        if owner == "admin" {
            tx.execute("INSERT INTO metadata VALUES('seeded','1')", [])
                .map_err(|e| e.to_string())?;
        } else {
            tx.execute("UPDATE invites SET seeded=1 WHERE id=?1", [owner])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn router(app: App) -> Router {
    Router::new()
        .route("/api/health", get(|| async { Json(json!({"ok":true})) }))
        .route("/api/session", get(session))
        .route("/api/login", post(login))
        .route("/api/invite-login", post(invites::login))
        .route("/api/invites", get(invites::list).post(invites::create))
        .route(
            "/api/invites/{id}",
            axum::routing::put(invites::update).delete(invites::delete),
        )
        .route("/api/logout", post(logout))
        .route("/api/password", post(change_password))
        .route("/api/trips", get(list_trips).post(create_trip))
        .route(
            "/api/trips/{id}",
            get(get_trip).put(update_trip).delete(delete_trip),
        )
        .route(
            "/api/trips/{id}/map-pack",
            get(map_pack::cached).post(map_pack::prepare),
        )
        .route(
            "/api/packing-template",
            get(get_template).put(update_template),
        )
        .fallback(|| async { ApiError(StatusCode::NOT_FOUND, "接口不存在".into(), None) })
        .method_not_allowed_fallback(|| async { bad("请求方法不支持") })
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app)
}
fn client_ip(req: &Request) -> IpAddr {
    let peer = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|x| x.0.ip())
        .unwrap_or(IpAddr::from([127, 0, 0, 1]));
    if peer.is_loopback() {
        req.headers()
            .get("x-real-ip")
            .and_then(|s| s.to_str().ok())
            .and_then(|s| s.parse().ok())
            .unwrap_or(peer)
    } else {
        peer
    }
}
async fn guard(State(app): State<App>, req: Request, next: Next) -> Response {
    let ip = client_ip(&req);
    let n = now();
    {
        let mut limits = match app.limits.lock() {
            Ok(l) => l,
            Err(e) => return internal(e).into_response(),
        };
        limits.retain(|_, (t, _)| n - *t < 60);
        if !limits.contains_key(&ip) && limits.len() >= 2048 {
            return ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "请求繁忙，请稍后重试".into(),
                Some(60),
            )
            .into_response();
        }
        let entry = limits.entry(ip).or_insert((n, 0));
        entry.1 += 1;
        if entry.1 > 120 {
            return ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "请求过于频繁".into(),
                Some(60 - (n - entry.0)),
            )
            .into_response();
        }
    }
    let mut req = req;
    req.extensions_mut().insert(ip);
    if ![Method::GET, Method::HEAD].contains(req.method())
        && req.headers().get("origin").and_then(|x| x.to_str().ok())
            != Some(app.config.origin.as_str())
    {
        return ApiError(StatusCode::FORBIDDEN, "来源校验失败".into(), None).into_response();
    }
    let path = req.uri().path();
    if ![
        "/api/health",
        "/api/login",
        "/api/invite-login",
        "/api/session",
    ]
    .contains(&path)
    {
        match authenticate(&app, req.headers()).await {
            Ok(auth) => {
                if path.starts_with("/api/invites") && auth.account_id != "admin" {
                    return ApiError(StatusCode::FORBIDDEN, "仅管理员可管理邀请名单".into(), None)
                        .into_response();
                }
                if ![Method::GET, Method::HEAD].contains(req.method())
                    && req
                        .headers()
                        .get("x-csrf-token")
                        .and_then(|x| x.to_str().ok())
                        != Some(auth.csrf.as_str())
                {
                    return ApiError(StatusCode::FORBIDDEN, "安全令牌校验失败".into(), None)
                        .into_response();
                }
                req.extensions_mut().insert(auth);
            }
            Err(e) => return e.into_response(),
        }
    }
    let mut response = next.run(req).await;
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    // Axum rejects malformed/oversized JSON before handlers; normalize those responses too.
    if [
        StatusCode::BAD_REQUEST,
        StatusCode::PAYLOAD_TOO_LARGE,
        StatusCode::UNPROCESSABLE_ENTITY,
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
    ]
    .contains(&response.status())
    {
        let status = if response.status() == StatusCode::PAYLOAD_TOO_LARGE {
            StatusCode::PAYLOAD_TOO_LARGE
        } else {
            StatusCode::BAD_REQUEST
        };
        if response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_none_or(|v| !v.starts_with("application/json"))
        {
            response = ApiError(
                status,
                if status == StatusCode::PAYLOAD_TOO_LARGE {
                    "请求超过 1 MiB"
                } else {
                    "请求格式无效"
                }
                .into(),
                None,
            )
            .into_response();
        }
    }
    response
}
#[derive(Clone)]
struct Auth {
    hash: String,
    csrf: String,
    username: String,
    account_id: String,
}
fn load_auth(c: &Connection, hashed: &str) -> Result<Auth, ApiError> {
    let n = now();
    let row:Option<(String,String)>=c.query_row("SELECT csrf,account_id FROM sessions WHERE token_hash=?1 AND created_at>?2 AND last_seen>?3",params![hashed,n-ABSOLUTE,n-IDLE],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(internal)?;
    let (csrf, account_id) = row.ok_or_else(unauthorized)?;
    let username = if account_id == "admin" {
        c.query_row("SELECT username FROM users WHERE id=1", [], |r| r.get(0))
            .map_err(internal)?
    } else {
        c.query_row(
            "SELECT name FROM invites WHERE id=?1 AND enabled=1 AND code_hash IS NOT NULL",
            [&account_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(internal)?
        .ok_or_else(unauthorized)?
    };
    c.execute(
        "UPDATE sessions SET last_seen=?1 WHERE token_hash=?2",
        params![n, hashed],
    )
    .map_err(internal)?;
    Ok(Auth {
        hash: hashed.into(),
        csrf,
        username,
        account_id,
    })
}
async fn authenticate(app: &App, h: &HeaderMap) -> Result<Auth, ApiError> {
    let cookie = h
        .get("cookie")
        .and_then(|x| x.to_str().ok())
        .ok_or_else(unauthorized)?;
    let name = format!("{}=", app.cookie_name());
    let t = cookie
        .split(';')
        .map(str::trim)
        .find_map(|s| s.strip_prefix(&name))
        .ok_or_else(unauthorized)?;
    if t.len() != 64 || !t.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(unauthorized());
    }
    let hashed = hash(t);
    app.run(move |c| {
        c.execute(
            "DELETE FROM sessions WHERE created_at<=?1 OR last_seen<=?2",
            params![now() - ABSOLUTE, now() - IDLE],
        )
        .map_err(internal)?;
        load_auth(c, &hashed)
    })
    .await
}
fn session_json(a: &Auth) -> Value {
    json!({"authenticated":true,"accountId":a.account_id,"username":a.username,"displayName":a.username,"role":if a.account_id=="admin"{"admin"}else{"friend"},"csrfToken":a.csrf})
}
async fn session(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>, ApiError> {
    match authenticate(&app, &h).await {
        Ok(a) => Ok(Json(session_json(&a))),
        Err(e) if e.0 == StatusCode::UNAUTHORIZED => Ok(Json(json!({"authenticated":false}))),
        Err(e) => Err(e),
    }
}
fn with_cookie(app: &App, t: &str, v: Value) -> Response {
    let mut r = Json(v).into_response();
    r.headers_mut().insert(
        "set-cookie",
        HeaderValue::from_str(&app.cookie(t, ABSOLUTE)).unwrap(),
    );
    r
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Login {
    username: String,
    password: String,
}
fn auth_keys(ip: IpAddr) -> [String; 2] {
    ["account".into(), format!("ip:{ip}")]
}
fn check_lock(c: &Connection, ip: IpAddr) -> Result<(), ApiError> {
    check_keys(c, &auth_keys(ip))
}
fn check_keys(c: &Connection, keys: &[String]) -> Result<(), ApiError> {
    let n = now();
    for key in keys {
        let lock: Option<i64> = c
            .query_row(
                "SELECT locked_until FROM auth_attempts WHERE key=?1",
                [key],
                |r| r.get(0),
            )
            .optional()
            .map_err(internal)?;
        if let Some(lock) = lock.filter(|l| *l > n) {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "登录尝试过多，请稍后重试".into(),
                Some(lock - n),
            ));
        }
    }
    Ok(())
}
fn failed_auth(c: &mut Connection, ip: IpAddr) -> Result<ApiError, ApiError> {
    failed_keys(c, &auth_keys(ip), "用户名或密码错误")
}
fn failed_keys(c: &mut Connection, keys: &[String], message: &str) -> Result<ApiError, ApiError> {
    let n = now();
    let tx = c.transaction().map_err(internal)?;
    tx.execute(
        "DELETE FROM auth_attempts WHERE window_start<?1 AND locked_until<=?2",
        params![n - 900, n],
    )
    .map_err(internal)?;
    for key in keys {
        tx.execute("INSERT INTO auth_attempts VALUES(?1,1,?2,0) ON CONFLICT(key) DO UPDATE SET failures=CASE WHEN window_start<=?2-900 THEN 1 ELSE failures+1 END,window_start=CASE WHEN window_start<=?2-900 THEN ?2 ELSE window_start END,locked_until=CASE WHEN window_start>?2-900 AND failures>=4 THEN ?2+900 ELSE 0 END",params![key,n]).map_err(internal)?;
    }
    let mut lock = 0;
    for key in keys {
        let value: i64 = tx
            .query_row(
                "SELECT locked_until FROM auth_attempts WHERE key=?1",
                [key],
                |r| r.get(0),
            )
            .map_err(internal)?;
        lock = lock.max(value);
    }
    tx.commit().map_err(internal)?;
    Ok(if lock > n {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "登录尝试过多，请稍后重试".into(),
            Some(lock - n),
        )
    } else {
        ApiError(StatusCode::UNAUTHORIZED, message.into(), None)
    })
}
async fn login(
    State(app): State<App>,
    axum::Extension(ip): axum::Extension<IpAddr>,
    Json(body): Json<Login>,
) -> Result<Response, ApiError> {
    if body.username.len() > 160 || body.password.len() > 1024 {
        return Err(bad("登录信息过长"));
    }
    let _permit = app.auth_slots.clone().try_acquire_owned().map_err(|_| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "登录繁忙，请稍后重试".into(),
            Some(2),
        )
    })?;
    let t = token();
    let th = hash(&t);
    let csrf = token();
    let a=app.run(move|c|{
        check_lock(c,ip)?;
        let user:Option<(String,String)>=c.query_row("SELECT username,password_hash FROM users WHERE id=1",[],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(internal)?;
        // Verify the same configured hash for unknown usernames to avoid enumeration timing.
        let valid=user.as_ref().is_some_and(|(name,h)|verify(&body.password,h)&&name==&body.username);
        if !valid{return Err(failed_auth(c,ip)?);}
        let (username,verified_hash)=user.unwrap();let n=now();let keys=auth_keys(ip);
        let tx=c.transaction().map_err(internal)?;
        // A local reset-password process may have changed credentials during Argon2 verification.
        let current_hash:String=tx.query_row("SELECT password_hash FROM users WHERE id=1",[],|r|r.get(0)).map_err(internal)?;
        if current_hash!=verified_hash{return Err(unauthorized());}
        tx.execute("DELETE FROM auth_attempts WHERE key IN (?1,?2)",params![keys[0],keys[1]]).map_err(internal)?;
        tx.execute("DELETE FROM sessions WHERE created_at<=?1 OR last_seen<=?2",params![n-ABSOLUTE,n-IDLE]).map_err(internal)?;
        tx.execute("DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE account_id='admin' ORDER BY created_at DESC LIMIT -1 OFFSET 19)",[]).map_err(internal)?;
        tx.execute("INSERT INTO sessions(token_hash,csrf,created_at,last_seen) VALUES(?1,?2,?3,?3)",params![th,csrf,n]).map_err(internal)?;
        tx.commit().map_err(internal)?;
        Ok(Auth{hash:th,csrf,username,account_id:"admin".into()})
    }).await?;
    Ok(with_cookie(&app, &t, session_json(&a)))
}

async fn logout(
    State(app): State<App>,
    axum::Extension(a): axum::Extension<Auth>,
) -> Result<Response, ApiError> {
    app.run(move |c| {
        c.execute("DELETE FROM sessions WHERE token_hash=?1", [a.hash])
            .map_err(internal)?;
        Ok(())
    })
    .await?;
    let mut r = StatusCode::NO_CONTENT.into_response();
    r.headers_mut().insert(
        "set-cookie",
        HeaderValue::from_str(&app.cookie("", 0)).unwrap(),
    );
    Ok(r)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Password {
    current_password: String,
    new_password: String,
}
async fn change_password(
    State(app): State<App>,
    axum::Extension(a): axum::Extension<Auth>,
    axum::Extension(ip): axum::Extension<IpAddr>,
    Json(b): Json<Password>,
) -> Result<Response, ApiError> {
    let valid = if a.account_id == "admin" {
        b.new_password.chars().count() >= 12 && b.new_password.len() <= 1024
    } else {
        invites::valid_code(&b.new_password)
    };
    if !valid || b.current_password.len() > 1024 {
        return Err(bad(
            "新凭证长度或格式无效（管理员至少 12 字符，朋友邀请码至少 8 字符）",
        ));
    }
    let _permit = app
        .auth_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError(StatusCode::TOO_MANY_REQUESTS, "请求繁忙".into(), Some(2)))?;
    let t = token();
    let th = hash(&t);
    let csrf = token();
    let live=app.run(move|c|{
        let a=load_auth(c,&a.hash)?;
        let keys=if a.account_id=="admin"{auth_keys(ip).to_vec()}else{vec![format!("invite:{}",a.account_id),format!("friend-ip:{ip}")]};
        check_keys(c,&keys)?;
        let old:String=if a.account_id=="admin"{c.query_row("SELECT password_hash FROM users WHERE id=1",[],|r|r.get(0)).map_err(internal)?}else{c.query_row("SELECT code_hash FROM invites WHERE id=?1",[&a.account_id],|r|r.get(0)).map_err(internal)?};
        if !verify(&b.current_password,&old){return Err(failed_keys(c,&keys,"当前凭证错误")?);}
        let new=password_hash(&b.new_password).map_err(internal)?;
        let tx=c.transaction().map_err(internal)?;
        if a.account_id=="admin"{tx.execute("UPDATE users SET password_hash=?1 WHERE id=1",[new]).map_err(internal)?;}else{tx.execute("UPDATE invites SET code_hash=?1,version=version+1 WHERE id=?2",params![new,a.account_id]).map_err(internal)?;}
        tx.execute("DELETE FROM sessions WHERE account_id=?1",[&a.account_id]).map_err(internal)?;
        for key in &keys{tx.execute("DELETE FROM auth_attempts WHERE key=?1",[key]).map_err(internal)?;}
        tx.execute("INSERT INTO sessions(token_hash,csrf,created_at,last_seen,account_id) VALUES(?1,?2,?3,?3,?4)",params![th,csrf,now(),a.account_id]).map_err(internal)?;
        tx.commit().map_err(internal)?;load_auth(c,&th)
    }).await?;
    Ok(with_cookie(&app, &t, session_json(&live)))
}
async fn list_trips(
    State(app): State<App>,
    axum::Extension(a): axum::Extension<Auth>,
) -> Result<Json<Value>, ApiError> {
    app.run(move|c|{
  let live=load_auth(c,&a.hash)?;let mut q=c.prepare("SELECT body FROM trips WHERE owner_id=?1 ORDER BY updated_at DESC,id").map_err(internal)?;
  let rows=q.query_map([live.account_id],|r|r.get::<_,String>(0)).map_err(internal)?;
  let mut trips=vec![];for row in rows{let t:Trip=serde_json::from_str(&row.map_err(internal)?).map_err(internal)?;trips.push(json!({"id":t.id,"name":t.input.name,"destination":t.input.destination,"startDate":t.input.start_date,"endDate":t.input.end_date,"version":t.input.version,"updatedAt":t.updated_at}));}
  Ok(Json(json!({"trips":trips})))
 }).await
}

fn read_trip(c: &Connection, id: &str, owner: &str) -> Result<Trip, ApiError> {
    let b: Option<String> = c
        .query_row(
            "SELECT body FROM trips WHERE id=?1 AND owner_id=?2",
            params![id, owner],
            |r| r.get(0),
        )
        .optional()
        .map_err(internal)?;
    serde_json::from_str(&b.ok_or(ApiError(StatusCode::NOT_FOUND, "行程不存在".into(), None))?)
        .map_err(internal)
}
async fn get_trip(
    State(app): State<App>,
    axum::Extension(a): axum::Extension<Auth>,
    Path(id): Path<String>,
) -> Result<Json<Trip>, ApiError> {
    app.run(move |c| {
        let live = load_auth(c, &a.hash)?;
        read_trip(c, &id, &live.account_id).map(Json)
    })
    .await
}

async fn create_trip(
    State(app): State<App>,
    axum::Extension(a): axum::Extension<Auth>,
    Json(mut input): Json<TripInput>,
) -> Result<(StatusCode, Json<Trip>), ApiError> {
    model::validate_trip(&input).map_err(bad)?;
    input.version = Some(1);
    app.run(move |c| {
        let live = load_auth(c, &a.hash)?;
        if input.packing.base_items.is_none() {
            let raw: String = c
                .query_row(
                    "SELECT body FROM packing_template WHERE owner_id=?1",
                    [&live.account_id],
                    |r| r.get(0),
                )
                .map_err(internal)?;
            let template: Template = serde_json::from_str(&raw).map_err(internal)?;
            input.packing.base_items = Some(template.items);
            input.packing.base_notes = Some(template.notes);
            model::validate_trip(&input).map_err(bad)?;
        }
        let count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM trips WHERE owner_id=?1",
                [&live.account_id],
                |r| r.get(0),
            )
            .map_err(internal)?;
        if count >= 200 {
            return Err(bad("行程数量已达 200 上限"));
        }
        let t = Trip {
            id: uuid::Uuid::new_v4().to_string(),
            input,
            updated_at: now(),
        };
        c.execute(
            "INSERT INTO trips(id,body,version,updated_at,owner_id) VALUES(?1,?2,1,?3,?4)",
            params![
                t.id,
                serde_json::to_string(&t).map_err(internal)?,
                t.updated_at,
                live.account_id
            ],
        )
        .map_err(internal)?;
        Ok((StatusCode::CREATED, Json(t)))
    })
    .await
}
fn conflict() -> ApiError {
    ApiError(
        StatusCode::CONFLICT,
        "数据已在其他页面修改，请重新加载".into(),
        None,
    )
}
async fn update_trip(
    State(app): State<App>,
    axum::Extension(a): axum::Extension<Auth>,
    Path(id): Path<String>,
    Json(mut input): Json<TripInput>,
) -> Result<Json<Trip>, ApiError> {
    model::validate_trip(&input).map_err(bad)?;
    let expected = input
        .version
        .filter(|n| *n > 0)
        .ok_or_else(|| bad("version required"))?;
    if expected == i64::MAX {
        return Err(bad("invalid version"));
    }
    app.run(move |c| {
        let live=load_auth(c,&a.hash)?;
        let old = read_trip(c, &id,&live.account_id)?;
        if old.input.version != Some(expected) {
            return Err(conflict());
        }
        input.version = Some(expected + 1);
        let t = Trip {
            id,
            input,
            updated_at: now().max(old.updated_at + 1),
        };
        c.execute(
            "UPDATE trips SET body=?1,version=?2,updated_at=?3 WHERE id=?4 AND version=?5 AND owner_id=?6",
            params![
                serde_json::to_string(&t).map_err(internal)?,
                expected + 1,
                t.updated_at,
                t.id,
                expected,live.account_id
            ],
        )
        .map_err(internal)?;
        Ok(Json(t))
    })
    .await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Version {
    version: i64,
}
async fn delete_trip(
    State(app): State<App>,
    axum::Extension(a): axum::Extension<Auth>,
    Path(id): Path<String>,
    Json(v): Json<Version>,
) -> Result<StatusCode, ApiError> {
    app.run(move |c| {
        let live = load_auth(c, &a.hash)?;
        let t = read_trip(c, &id, &live.account_id)?;
        if t.input.version != Some(v.version) {
            return Err(conflict());
        }
        c.execute(
            "DELETE FROM trips WHERE id=?1 AND version=?2 AND owner_id=?3",
            params![id, v.version, live.account_id],
        )
        .map_err(internal)?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}
async fn get_template(
    State(app): State<App>,
    axum::Extension(a): axum::Extension<Auth>,
) -> Result<Json<Template>, ApiError> {
    app.run(move |c| {
        let live = load_auth(c, &a.hash)?;
        let b: String = c
            .query_row(
                "SELECT body FROM packing_template WHERE owner_id=?1",
                [&live.account_id],
                |r| r.get(0),
            )
            .map_err(internal)?;
        Ok(Json(serde_json::from_str(&b).map_err(internal)?))
    })
    .await
}
async fn update_template(
    State(app): State<App>,
    axum::Extension(a): axum::Extension<Auth>,
    Json(mut t): Json<Template>,
) -> Result<Json<Template>, ApiError> {
    model::validate_template(&t).map_err(bad)?;
    if t.version == i64::MAX {
        return Err(bad("invalid version"));
    }
    app.run(move |c| {
        let live = load_auth(c, &a.hash)?;
        let expected = t.version;
        t.version += 1;
        let affected = c
            .execute(
                "UPDATE packing_template SET body=?1,version=?2 WHERE owner_id=?4 AND version=?3",
                params![
                    serde_json::to_string(&t).map_err(internal)?,
                    t.version,
                    expected,
                    live.account_id
                ],
            )
            .map_err(internal)?;
        if affected == 0 {
            return Err(conflict());
        }
        Ok(Json(t))
    })
    .await
}
