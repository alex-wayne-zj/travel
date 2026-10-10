use rusqlite::{Connection, params};
use std::{
    env, fs,
    net::SocketAddr,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
};
use travel_backend::{App, Config, password_hash, router};

fn env_value(k: &str, d: &str) -> String {
    env::var(k).unwrap_or_else(|_| d.into())
}
fn arg(args: &[String], key: &str) -> Result<String, String> {
    args.windows(2)
        .find(|a| a[0] == key)
        .map(|a| a[1].clone())
        .ok_or_else(|| format!("missing {key}"))
}
fn open_db(path: &str) -> Result<Connection, String> {
    let p = Path::new(path);
    if let Some(parent) = p.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if !p.exists() {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(p)
            .map_err(|e| e.to_string())?;
    }
    fs::set_permissions(p, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    Connection::open(path).map_err(|e| e.to_string())
}
fn admin_command(app: &App, args: &[String], initialize: bool) -> Result<(), String> {
    let username = arg(args, "--username")?;
    if username.trim().is_empty()
        || username.len() > 160
        || username.chars().any(|c| c.is_control())
    {
        return Err("invalid username".into());
    }
    let pw_path = arg(args, "--password-file")?;
    let meta = fs::metadata(&pw_path).map_err(|_| "cannot read password file")?;
    if !meta.is_file() || meta.len() > 4096 || meta.permissions().mode() & 0o077 != 0 {
        return Err("password file must be <=4096 bytes and have mode 0600 or stricter".into());
    }
    let password = fs::read_to_string(pw_path).map_err(|_| "cannot read password file")?;
    let password = password.trim();
    if password.chars().count() < 12 || password.len() > 1024 {
        return Err("password must contain >=12 characters and <=1024 bytes".into());
    }
    let hashed = password_hash(password)?;
    let mut c = app.db.lock().map_err(|_| "database lock unavailable")?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let count: i64 = tx
        .query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if initialize && count != 0 {
        return Err("admin already initialized; use reset-password explicitly".into());
    }
    if !initialize && count == 0 {
        return Err("admin not initialized".into());
    }
    tx.execute("INSERT INTO users VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash",params![username,hashed]).map_err(|e|e.to_string())?;
    tx.execute("DELETE FROM sessions WHERE account_id='admin'", [])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM auth_attempts WHERE key='account' OR key LIKE 'ip:%'",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    println!("admin credentials updated; administrator sessions revoked");
    Ok(())
}
fn backup(c: &Connection, args: &[String]) -> Result<(), String> {
    let output = arg(args, "--output")?;
    // Create with private permissions before SQLite writes sensitive trip and account data.
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&output)
        .map_err(|_| "backup output must not already exist and its directory must be writable")?;
    c.backup("main", &output, None)
        .map_err(|_| "SQLite backup failed (partial output retained for inspection)")?;
    println!("consistent SQLite backup completed");
    Ok(())
}
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("travel-backend: {e}");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let path = env_value("TRAVEL_DB_PATH", "./travel.db");
    if args.first().is_some_and(|c| c == "backup") && !Path::new(&path).is_file() {
        return Err("backup source database does not exist".into());
    }
    let secure = match env_value("TRAVEL_SECURE_COOKIE", "true").as_str() {
        "true" => true,
        "false" => false,
        _ => return Err("TRAVEL_SECURE_COOKIE must be true or false".into()),
    };
    let origin = env_value("TRAVEL_ORIGIN", "https://localhost");
    let parsed = url::Url::parse(&origin).map_err(|_| "invalid TRAVEL_ORIGIN")?;
    if parsed.host_str().is_none()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !["https", "http"].contains(&parsed.scheme())
        || (secure && parsed.scheme() != "https")
        || parsed.origin().ascii_serialization() != origin
    {
        return Err("TRAVEL_ORIGIN must be an exact origin without a trailing slash; secure cookies require HTTPS".into());
    }
    let conn = open_db(&path)?;
    if args.first().is_some_and(|c| c == "backup") {
        return backup(&conn, &args);
    }
    let app = App::new(
        conn,
        Config {
            origin,
            secure_cookie: secure,
        },
    )?;
    if let Some(command) = args.first() {
        return match command.as_str(){
            "init-admin"=>admin_command(&app,&args,true),
            "reset-password"=>admin_command(&app,&args,false),

            _=>Err("commands: init-admin --username NAME --password-file PATH; reset-password --username NAME --password-file PATH; backup --output PATH".into())
        };
    }
    let initialized: i64 = app
        .db
        .lock()
        .map_err(|_| "database lock unavailable")?
        .query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if initialized != 1 {
        return Err("run init-admin locally before starting the server".into());
    }
    let bind: SocketAddr = env_value("TRAVEL_BIND", "127.0.0.1:8078")
        .parse()
        .map_err(|_| "invalid TRAVEL_BIND")?;
    if !bind.ip().is_loopback() {
        return Err(
            "TRAVEL_BIND must be loopback; expose only through the HTTPS reverse proxy".into(),
        );
    }
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|e| e.to_string())?;
    eprintln!("travel-backend listening on {bind}");
    axum::serve(
        listener,
        router(app).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! { _=tokio::signal::ctrl_c()=>{}, _=term.recv()=>{} }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}
