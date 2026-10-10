//! Friend login credentials; each invitation owns an independent planning space.
use super::*;
use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub has_code: bool,
    pub version: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InviteInput {
    pub name: String,
    pub enabled: bool,
    pub code: Option<String>,
    pub version: Option<i64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InviteLogin {
    pub name: String,
    pub code: String,
}
pub fn normalize_name(s: &str) -> String {
    s.nfkc()
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
pub fn valid_code(code: &str) -> bool {
    code.chars().count() >= 8
        && code.len() <= 256
        && code.trim() == code
        && !code.chars().any(char::is_control)
}
fn validate(input: &InviteInput) -> Result<(), ApiError> {
    if normalize_name(&input.name).is_empty()
        || input.name.chars().count() > 80
        || input.name.chars().any(char::is_control)
    {
        return Err(bad("名字需为 1–80 字符"));
    }
    if input.code.as_ref().is_some_and(|code| !valid_code(code)) {
        return Err(bad(
            "邀请码需至少 8 字符，最多 256 字节，不能含首尾空白或控制符",
        ));
    }
    Ok(())
}
fn read(c: &Connection, id: &str) -> Result<Invite, ApiError> {
    let row: Option<(String, bool, bool, i64)> = c
        .query_row(
            "SELECT name,enabled,code_hash IS NOT NULL,version FROM invites WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(internal)?;
    let (name, enabled, has_code, version) =
        row.ok_or(ApiError(StatusCode::NOT_FOUND, "邀请不存在".into(), None))?;
    Ok(Invite {
        id: id.into(),
        name,
        enabled,
        has_code,
        version,
    })
}
fn name_available(c: &Connection, name: &str, except: Option<&str>) -> Result<(), ApiError> {
    let existing: Option<String> = c
        .query_row(
            "SELECT id FROM invites WHERE normalized_name=?1",
            [normalize_name(name)],
            |r| r.get(0),
        )
        .optional()
        .map_err(internal)?;
    if existing.as_deref().is_some_and(|id| Some(id) != except) {
        return Err(ApiError(StatusCode::CONFLICT, "该名字已存在".into(), None));
    }
    Ok(())
}
fn ensure_admin(c: &Connection, a: &Auth) -> Result<(), ApiError> {
    let live = load_auth(c, &a.hash)?;
    if live.account_id != "admin" {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "仅管理员可管理邀请名单".into(),
            None,
        ));
    }
    Ok(())
}
pub async fn list(
    State(app): State<App>,
    axum::Extension(a): axum::Extension<Auth>,
) -> Result<Json<Value>, ApiError> {
    app.run(move |c| {
        ensure_admin(c, &a)?;
        let ids = {
            let mut q = c
                .prepare("SELECT id FROM invites ORDER BY rowid")
                .map_err(internal)?;
            q.query_map([], |r| r.get::<_, String>(0))
                .map_err(internal)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(internal)?
        };
        let records = ids
            .iter()
            .map(|id| read(c, id))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Json(json!({"invites":records})))
    })
    .await
}
pub async fn create(
    State(app): State<App>,
    axum::Extension(a): axum::Extension<Auth>,
    Json(input): Json<InviteInput>,
) -> Result<(StatusCode, Json<Invite>), ApiError> {
    validate(&input)?;
    let _permit = app
        .auth_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError(StatusCode::TOO_MANY_REQUESTS, "请求繁忙".into(), Some(2)))?;
    app.run(move |c| {
        ensure_admin(c, &a)?;
        name_available(c, &input.name, None)?;
        if input.enabled && input.code.is_none() {
            return Err(bad("启用前必须设置邀请码"));
        }
        let count: i64 = c
            .query_row("SELECT COUNT(*) FROM invites", [], |r| r.get(0))
            .map_err(internal)?;
        if count >= 50 {
            return Err(bad("最多 50 位朋友"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let hashed = input
            .code
            .as_deref()
            .map(password_hash)
            .transpose()
            .map_err(internal)?;
        c.execute(
            "INSERT INTO invites(id,name,normalized_name,code_hash,enabled) VALUES(?1,?2,?3,?4,?5)",
            params![
                id,
                input.name.trim(),
                normalize_name(&input.name),
                hashed,
                input.enabled
            ],
        )
        .map_err(internal)?;
        Ok((StatusCode::CREATED, Json(read(c, &id)?)))
    })
    .await
}
pub async fn update(
    State(app): State<App>,
    axum::Extension(a): axum::Extension<Auth>,
    Path(id): Path<String>,
    Json(input): Json<InviteInput>,
) -> Result<Json<Invite>, ApiError> {
    validate(&input)?;
    let _permit = app
        .auth_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError(StatusCode::TOO_MANY_REQUESTS, "请求繁忙".into(), Some(2)))?;
    app.run(move|c|{
 ensure_admin(c,&a)?;
 let old=read(c,&id)?;let expected=input.version.filter(|n|*n>0&&*n<i64::MAX).ok_or_else(||bad("version required"))?;if expected!=old.version{return Err(conflict());}
 name_available(c,&input.name,Some(&id))?;if input.enabled&&!old.has_code&&input.code.is_none(){return Err(bad("启用前必须设置邀请码"));}
 let hashed=input.code.as_deref().map(password_hash).transpose().map_err(internal)?;
 let tx=c.transaction().map_err(internal)?;
 let affected=tx.execute("UPDATE invites SET name=?1,normalized_name=?2,code_hash=COALESCE(?3,code_hash),enabled=?4,version=version+1 WHERE id=?5 AND version=?6",params![input.name.trim(),normalize_name(&input.name),hashed,input.enabled,id,expected]).map_err(internal)?;
 if affected!=1{return Err(conflict());}
 tx.execute("DELETE FROM sessions WHERE account_id=?1",[&id]).map_err(internal)?;
 tx.execute("DELETE FROM auth_attempts WHERE key=?1",[format!("invite:{id}")]).map_err(internal)?;
 tx.commit().map_err(internal)?;Ok(Json(read(c,&id)?))
 }).await
}
pub async fn delete(
    State(app): State<App>,
    axum::Extension(a): axum::Extension<Auth>,
    Path(id): Path<String>,
    Json(v): Json<Version>,
) -> Result<StatusCode, ApiError> {
    app.run(move |c| {
        ensure_admin(c, &a)?;
        let old = read(c, &id)?;
        if old.version != v.version {
            return Err(conflict());
        }
        let tx = c.transaction().map_err(internal)?;
        tx.execute("DELETE FROM sessions WHERE account_id=?1", [&id])
            .map_err(internal)?;
        tx.execute(
            "DELETE FROM invites WHERE id=?1 AND version=?2",
            params![id, v.version],
        )
        .map_err(internal)?;
        tx.execute(
            "DELETE FROM auth_attempts WHERE key=?1",
            [format!("invite:{id}")],
        )
        .map_err(internal)?;
        // Deleting login credentials must not silently erase the friend's private planning data.
        tx.commit().map_err(internal)?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}
pub async fn login(
    State(app): State<App>,
    axum::Extension(ip): axum::Extension<IpAddr>,
    Json(body): Json<InviteLogin>,
) -> Result<Response, ApiError> {
    if body.name.chars().count() > 80 || body.code.len() > 256 {
        return Err(bad("登录信息过长"));
    }
    let _permit = app
        .auth_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError(StatusCode::TOO_MANY_REQUESTS, "登录繁忙".into(), Some(2)))?;
    let t = token();
    let th = hash(&t);
    let csrf = token();
    let a=app.run(move|c|{
 let row:Option<(String,Option<String>,bool)>=c.query_row("SELECT id,code_hash,enabled FROM invites WHERE normalized_name=?1",[normalize_name(&body.name)],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(internal)?;
 let mut keys=vec![format!("friend-ip:{ip}")];if let Some((id,_,_))=&row{keys.push(format!("invite:{id}"));}
 check_keys(c,&keys)?;
 // Unknown or disabled friends perform one verification without writing administrator lock keys.
 let fallback:String=c.query_row("SELECT password_hash FROM users WHERE id=1",[],|r|r.get(0)).map_err(internal)?;
 let h=row.as_ref().and_then(|(_,h,_)|h.as_deref()).unwrap_or(&fallback);let verified=verify(&body.code,h);
 if !verified||!row.as_ref().is_some_and(|(_,h,enabled)|*enabled&&h.is_some()){return Err(failed_keys(c,&keys,"名字或邀请码无效")?);}
 let id=row.unwrap().0;
 seed_space(c,&id).map_err(internal)?;
 let n=now();let tx=c.transaction().map_err(internal)?;
 for key in &keys{tx.execute("DELETE FROM auth_attempts WHERE key=?1",[key]).map_err(internal)?;}
 tx.execute("DELETE FROM sessions WHERE created_at<=?1 OR last_seen<=?2",params![n-ABSOLUTE,n-IDLE]).map_err(internal)?;
 tx.execute("DELETE FROM sessions WHERE token_hash IN(SELECT token_hash FROM sessions WHERE account_id=?1 ORDER BY created_at DESC LIMIT -1 OFFSET 19)",[&id]).map_err(internal)?;
 tx.execute("INSERT INTO sessions(token_hash,csrf,created_at,last_seen,account_id) VALUES(?1,?2,?3,?3,?4)",params![th,csrf,n,id]).map_err(internal)?;
 tx.commit().map_err(internal)?;load_auth(c,&th)
 }).await?;
    Ok(with_cookie(&app, &t, session_json(&a)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn queued_invite_handlers_reject_revoked_administrator_session() {
        let app = App::new(
            Connection::open_in_memory().unwrap(),
            Config {
                origin: "https://test.example".into(),
                secure_cookie: true,
            },
        )
        .unwrap();
        let captured = {
            let c = app.db.lock().unwrap();
            c.execute(
                "INSERT INTO users VALUES(1,'admin',?1)",
                [password_hash("test-admin-password").unwrap()],
            )
            .unwrap();
            let h = hash(&token());
            c.execute("INSERT INTO sessions(token_hash,csrf,created_at,last_seen) VALUES(?1,'csrf',?2,?2)",params![h,now()]).unwrap();
            let captured = load_auth(&c, &h).unwrap();
            c.execute("DELETE FROM sessions", []).unwrap();
            captured
        };
        let id: String = app
            .db
            .lock()
            .unwrap()
            .query_row("SELECT id FROM invites LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            list(State(app.clone()), axum::Extension(captured.clone()))
                .await
                .err()
                .unwrap()
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            create(
                State(app.clone()),
                axum::Extension(captured.clone()),
                Json(InviteInput {
                    name: "Friend".into(),
                    enabled: false,
                    code: None,
                    version: None
                })
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            update(
                State(app.clone()),
                axum::Extension(captured.clone()),
                Path(id.clone()),
                Json(InviteInput {
                    name: "Friend".into(),
                    enabled: false,
                    code: None,
                    version: Some(1)
                })
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            delete(
                State(app.clone()),
                axum::Extension(captured),
                Path(id),
                Json(Version { version: 1 })
            )
            .await
            .err()
            .unwrap()
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            app.db
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM invites", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
}
