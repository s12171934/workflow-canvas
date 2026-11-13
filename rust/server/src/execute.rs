use crate::{
    app::State,
    error::{Error, Result},
    prompts,
    runlog::{self},
    store::{Store, mkdir, write_private},
};
use serde_json::{Value, json};
use std::{fs, path::PathBuf, sync::Arc};
use workflow_core::{JsonExt, entries, model, object, validate, workflow};
pub fn preflight(store: &Store, g: &Value) -> Value {
    preflight_with(g, store.linked(g))
}
pub fn preflight_with(g: &Value, load: Result<Value>) -> Value {
    let mut checks = vec![];
    let linked = match load {
        Ok(v) => {
            checks.push(json!({"name":"links","ok":true}));
            v
        }
        Err(e) => {
            checks.push(json!({"name":"links","ok":false,"message":e.message}));
            object()
        }
    };
    let all: Vec<Value> = std::iter::once(g.clone())
        .chain(entries(&linked).into_iter().map(|(_, v)| v))
        .collect();
    for name in [
        "stages",
        "groups",
        "branches",
        "spawns",
        "scripts",
        "sessions",
        "variables",
        "loops",
        "coordinator",
        "flow",
    ] {
        let result = match name {
            "stages" => {
                if g.a("nodes").iter().any(model::executable) {
                    Ok(())
                } else {
                    Err("실행할 단계가 없습니다.".into())
                }
            }
            "flow" => workflow::flow(g, &linked).map(|_| ()),
            _ => workflow::check(name, &all, &linked),
        };
        checks.push(match result {
            Ok(()) => json!({"name":name,"ok":true}),
            Err(message) => json!({"name":name,"ok":false,"message":message}),
        })
    }
    let mut warnings = vec![];
    for graph in &all {
        let where_ = if all.len() > 1 {
            format!("'{}'의 ", graph.s("name"))
        } else {
            String::new()
        };
        let stages: Vec<&Value> = graph
            .a("nodes")
            .iter()
            .filter(|n| model::executable(n))
            .collect();
        let mut sessions: Vec<(String, Vec<(String, Vec<String>)>)> = vec![];
        for n in graph.a("nodes") {
            let key = model::session(n);
            if key.is_empty()
                || (n["data"].s("workerModel").is_empty() && n["data"].s("effort").is_empty())
            {
                continue;
            }
            let d = &n["data"];
            let setting = format!(
                "{}{}",
                if d.s("workerModel").is_empty() {
                    model::DEFAULT_MODEL
                } else {
                    d.s("workerModel")
                },
                if d.s("effort").is_empty() {
                    String::new()
                } else {
                    format!(" · {}", d.s("effort"))
                }
            );
            let index = sessions
                .iter()
                .position(|(k, _)| k == key)
                .unwrap_or_else(|| {
                    sessions.push((key.into(), vec![]));
                    sessions.len() - 1
                });
            let by = &mut sessions[index].1;
            let idx = by
                .iter()
                .position(|(s, _)| s == &setting)
                .unwrap_or_else(|| {
                    by.push((setting, vec![]));
                    by.len() - 1
                });
            by[idx].1.push(
                if d.s("label").is_empty() {
                    n.s("id")
                } else {
                    d.s("label")
                }
                .into(),
            );
        }
        for (key, settings) in sessions {
            if settings.len() > 1 {
                warnings.push(format!("{where_}세션 '{key}' 의 단계마다 모델·effort 가 다릅니다({}). 한 실행에서는 먼저 닿은 단계의 값으로 돌고 뒤 단계의 값은 무시됩니다.",settings.iter().map(|(s,n)|format!("{}: {s}",n.join("·"))).collect::<Vec<_>>().join(" / ")))
            }
        }
        for branch in graph.a("nodes").iter().filter(|n| model::branch(n)) {
            for output in branch["data"].a("outputs") {
                if !graph.a("edges").iter().any(|e| {
                    e.s("source") == branch.s("id") && e.s("sourceHandle") == output.s("id")
                }) {
                    warnings.push(format!(
                        "{where_}'{}' 분기의 출력 '{}'({}) 에 이어진 단계가 없습니다.",
                        if branch["data"].s("label").is_empty() {
                            "분기"
                        } else {
                            branch["data"].s("label")
                        },
                        if output.s("label").is_empty() {
                            output.s("id")
                        } else {
                            output.s("label")
                        },
                        output.s("id")
                    ))
                }
            }
        }
        let used: Vec<String> = graph
            .a("nodes")
            .iter()
            .flat_map(|n| {
                let d = &n["data"];
                let mut refs = model::variable_refs(&format!(
                    "{}\n{}\n{}",
                    d.s("description"),
                    d.s("command"),
                    d.s("parentPath")
                ));
                if !d["fanout"].s("variable").is_empty() {
                    refs.push(d["fanout"].s("variable").into())
                }
                refs
            })
            .collect();
        for v in graph.a("variables") {
            if !used.iter().any(|k| k == v.s("key")) {
                warnings.push(format!("{where_}설정값 '{}'({}) 이(가) 어느 지침·명령에도 `{{{{{}}}}}` 로 쓰이지 않아 워커에게 닿지 않습니다.",v.s("label"),v.s("key"),v.s("key")))
            }
        }
        for n in graph.a("nodes") {
            let text = n["data"].s("description");
            let name = if n["data"].s("label").is_empty() {
                n.s("id")
            } else {
                n["data"].s("label")
            };
            if validate::matches(r"중괄호\s*그대로", text) {
                warnings.push(format!("{where_}'{name}' 지침이 「중괄호 그대로」로 빈 설정값을 판별합니다. 빈 설정값은 빈 문자열이 되므로 「값이 비어 있으면」으로 쓰세요."))
            }
            if (text.contains("-r*") || validate::matches(r"가장\s*최근\s*회차", text))
                && !text.contains("숫자")
                && !text.contains("ls -t")
            {
                warnings.push(format!("{where_}'{name}' 지침이 「가장 최근 회차」를 이름(`-r*`)으로 고르는 것 같습니다. 이름 사전순이면 -r10 이 -r2 앞에 옵니다 — -r<k> 의 k 를 숫자로 비교해 고르세요."))
            }
        }
        if stages.len() > 1 {
            for n in stages {
                if !graph
                    .a("edges")
                    .iter()
                    .any(|e| e.s("source") == n.s("id") || e.s("target") == n.s("id"))
                {
                    warnings.push(format!("{where_}'{}' 이(가) 어느 단계와도 연결되지 않아 실행 시작과 함께 따로 돕니다.",if n["data"].s("label").is_empty(){"단계"}else{n["data"].s("label")}))
                }
            }
        }
    }
    json!({"ok":checks.iter().all(|c|c.b("ok")),"checks":checks,"warnings":warnings,"linked":entries(&linked).iter().map(|(k,_)|k).collect::<Vec<_>>()})
}
pub async fn settings(state: &State, g: &Value, body: &Value) -> Result<Value> {
    let count = body["count"]
        .as_f64()
        .or_else(|| body["count"].as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0.);
    if count.fract() != 0. || !(1. ..=20.).contains(&count) {
        return Err(Error::new(400, "실행 횟수는 1~20 사이여야 합니다."));
    }
    let project = body.s("project");
    let locations = state
        .bridge
        .read("locations", json!([]), None)
        .await
        .map_err(|_| Error::new(503, "Orca 프로젝트 목록을 확인할 수 없습니다."))?;
    if !locations
        .a("projects")
        .iter()
        .any(|p| p.s("path") == project)
    {
        return Err(Error::new(
            400,
            "실행할 프로젝트를 Orca에 열린 프로젝트 중에서 고르세요.",
        ));
    }
    let inputs = body
        .get("inputs")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(object());
    let ask: Vec<&str> = g
        .a("nodes")
        .iter()
        .filter(|n| model::create(n) && n["data"].s("nameSource") == "input")
        .map(|n| n.s("id"))
        .collect();
    if !inputs.is_object()
        || entries(&inputs).iter().any(|(k, v)| {
            !ask.contains(&k.as_str())
                || !v.is_string()
                || (!v.text().is_empty() && !validate::valid_name(v.text()))
        })
    {
        return Err(Error::new(
            400,
            "워크트리 이름은 영문·숫자·. _ - 만 쓸 수 있고 -로 시작할 수 없습니다.",
        ));
    }
    let cleanup = body
        .get("cleanup")
        .filter(|v| !v.is_null())
        .or(g.get("cleanup"))
        .cloned()
        .unwrap_or(json!({"coordinator":false,"worktrees":false,"sessions":true}));
    if !cleanup.is_object()
        || ["coordinator", "worktrees", "sessions"]
            .iter()
            .any(|k| !cleanup[*k].is_boolean())
    {
        return Err(Error::new(400, "완료 시 정리 설정이 올바르지 않습니다."));
    }
    let title = body
        .get("title")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!(""));
    if !title.is_string()
        || validate::length(title.text()) > 60
        || title.text().contains(['\r', '\n'])
    {
        return Err(Error::new(400, "실행 이름은 한 줄, 60자 이하여야 합니다."));
    }
    let title = title
        .text()
        .replace(['"', '`', '\'', '\\'], "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let raw = body
        .get("values")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(object());
    if !raw.is_object() {
        return Err(Error::new(
            400,
            "설정값은 {\"<키>\":\"<값>\"} 형식이어야 합니다.",
        ));
    }
    let mut given = object();
    for (k, v) in entries(&raw) {
        let Some(declared) = g.a("variables").iter().find(|v| v.s("key") == k) else {
            return Err(Error::new(
                400,
                format!("「{}」에 없는 설정값입니다: {k}", g.s("name")),
            ));
        };
        if !validate::valid_value(&v) {
            return Err(Error::new(
                400,
                format!(
                    "「{}」 값은 한 줄, 2000자 이하여야 합니다.",
                    declared.s("label")
                ),
            ));
        }
        if !v.text().trim().is_empty() {
            given[k] = json!(v.text().trim())
        }
    }
    let resolved = model::resolve_variables(&g["variables"], &given);
    if !resolved.a("missing").is_empty() {
        return Err(Error::new(
            400,
            format!(
                "필수 설정값을 입력하세요: {}",
                resolved
                    .a("missing")
                    .iter()
                    .map(|v| format!("「{}」", v.s("label")))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ));
    }
    let mut out = json!({"count":count,"project":project,"inputs":inputs,"cleanup":cleanup,"given":given,"values":resolved["values"]});
    if !title.is_empty() {
        out["title"] = json!(title)
    }
    Ok(out)
}
fn sorted_pairs(v: &Value) -> Value {
    let mut pairs = entries(v)
        .into_iter()
        .filter(|(_, v)| workflow_core::truth(v))
        .collect::<Vec<_>>();
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    json!(pairs)
}
pub fn request_key(inputs: &Value, values: &Value) -> String {
    json!([sorted_pairs(inputs).to_string(), sorted_pairs(values)]).to_string()
}
fn title(settings: &Value, started: &str) -> String {
    if !settings.s("title").is_empty() {
        return settings.s("title").into();
    }
    let given = entries(&settings["inputs"])
        .iter()
        .filter(|(_, v)| workflow_core::truth(v))
        .map(|(_, v)| v.text())
        .collect::<Vec<_>>()
        .join("·");
    if !given.is_empty() {
        return given.chars().take(60).collect();
    }
    let date = chrono::DateTime::parse_from_rfc3339(started)
        .unwrap()
        .with_timezone(&chrono::Local);
    let time = date.format("%m-%d %H:%M").to_string();
    if settings["automation"].is_null() {
        time
    } else {
        format!(
            "{} {time}",
            settings["automation"]
                .s("name")
                .replace(['"', '`', '\'', '\\'], "")
                .chars()
                .take(48)
                .collect::<String>()
        )
    }
}
pub async fn prepare(state: &State, g: &Value, settings: &Value) -> Result<Value> {
    if !g.a("nodes").iter().any(model::executable) {
        return Err(Error::new(400, "실행할 단계가 없습니다."));
    }
    let linked = state.store.linked(g)?;
    let all = std::iter::once(g.clone())
        .chain(entries(&linked).into_iter().map(|(_, v)| v))
        .collect::<Vec<_>>();
    for check in [
        "groups",
        "branches",
        "spawns",
        "scripts",
        "sessions",
        "variables",
        "loops",
        "coordinator",
    ] {
        workflow::check(check, &all, &linked)?
    }
    let request = request_key(&settings["inputs"], &settings["values"]);
    let launch_key = format!("{}\n{request}", g.s("id"));
    {
        let mut launches = state.launches.lock().await;
        if launches
            .get(&launch_key)
            .is_some_and(|at| runlog::millis() - at < 60000)
        {
            return Err(Error::new(
                409,
                "방금 같은 입력·설정값으로 실행을 요청했습니다. 코디네이터가 실행을 등록할 때까지 잠시 기다리세요.",
            ));
        }
        launches.insert(launch_key.clone(), runlog::millis());
    }
    let result=async{let same=g.a("executions").iter().filter(|e|request_key(&e["inputs"],&e["values"])==request&&!model::execution_run(g,e).is_empty()).collect::<Vec<_>>();let mut open=0;for run in model::unique(same.iter().map(|e|model::execution_run(g,e).into())){let snapshot=state.bridge.read("snapshot",json!([run]),None).await.map_err(|_|Error::new(409,"이전 실행 상태를 확인할 수 없습니다. 잠시 뒤 다시 시도하거나 Run 연결을 해제하세요."))?;open+=same.iter().filter(|e|model::execution_run(g,e)==run&&!model::finished(&model::statuses(g.a("nodes"),e,&snapshot,false))).count()}if open>0{return Err(Error::new(409,format!("{}진행 중인 실행 {open}개가 끝난 뒤 다시 실행하세요.",if request==request_key(&object(),&object()){""}else{"같은 입력·설정값의 "})))}mkdir(&state.log.root)?;let mut started=chrono::Utc::now();let log_id=loop{let id=runlog::launch_name(&started.to_rfc3339_opts(chrono::SecondsFormat::Millis,true),g.s("id"));match fs::create_dir(state.log.root.join(&id)){Ok(())=>{mkdir(&state.log.root.join(&id))?;break id},Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>started+=chrono::Duration::milliseconds(1),Err(e)=>return Err(e.into())}};let started=started.to_rfc3339_opts(chrono::SecondsFormat::Millis,true);let title=title(settings,&started);let dir=state.log.root.join(&log_id);let mut meta=json!({"workflowId":g["id"],"workflowName":g["name"],"startedAt":started,"count":settings["count"],"title":title,"project":settings["project"]});for k in["automation","parent"]{if !settings[k].is_null(){meta[k]=settings[k].clone()}}let inputs=Value::Object(entries(&settings["inputs"]).into_iter().filter(|(_,v)|workflow_core::truth(v)).collect());if !entries(&inputs).is_empty(){meta["inputs"]=inputs}if !entries(&settings["values"]).is_empty(){meta["values"]=settings["values"].clone()}if settings["cleanup"].b("coordinator")&&settings["automation"].is_null()&&settings["parent"].is_null(){meta["closeCoordinator"]=json!(true)}state.log.start(&log_id,&meta)?;let origin=if !settings.s("origin").is_empty(){settings.s("origin").to_owned()}else if !settings["automation"].is_null(){format!("자동화 「{}」",settings["automation"].s("name"))}else{"실행 버튼".into()};let input_names=entries(&settings["inputs"]).iter().filter(|(_,v)|workflow_core::truth(v)).map(|(_,v)|v.text()).collect::<Vec<_>>().join("·");state.log.append(&log_id,&json!({"type":"requested","message":format!("「{title}」 · {origin} · {}회 · {}{}",settings.n("count"),settings.s("project"),if input_names.is_empty(){String::new()}else{format!(" · 입력 {input_names}")})}))?;let brief=dir.join("brief.md");let mut input=json!({"graph":g,"linked":linked,"count":settings["count"],"title":title,"apiBase":state.base,"workspace":settings["project"],"artifactDir":dir,"logUrl":format!("{}/api/workflows/{}/logs/{log_id}/events",state.base,g.s("id")),"launchId":log_id,"values":settings["values"],"inputs":settings["inputs"],"cleanup":settings["cleanup"]});if !settings["automation"].is_null(){input["automation"]=settings["automation"].clone()}let prepared=settings.get("preparedGroup").cloned().unwrap_or_else(||if settings.b("coordinatorInGroup"){g["coordinatorGroup"].clone()}else{Value::Null});if !prepared.is_null(){input["preparedGroup"]=prepared}if !settings["parent"].is_null(){input["subcoordinator"]=json!({"parentName":if settings.s("origin").is_empty(){settings["parent"].s("workflowId")}else{settings.s("origin")}})}let composed=prompts::compose(&input)?;for file in composed.a("files"){let path=PathBuf::from(file.s("path"));mkdir(path.parent().unwrap())?;write_private(&path,file.s("content").as_bytes())?}write_private(&brief,composed.s("brief").as_bytes())?;state.log.append(&log_id,&json!({"type":"brief","message":"코디네이터 브리프 작성"}))?;Ok(json!({"briefPath":brief,"logId":log_id,"launchKey":launch_key,"title":title}))}.await;
    if result.is_err() {
        state.launches.lock().await.remove(&launch_key);
    }
    result
}
pub fn coordinator_target(g: &Value, settings: &Value, group_id: &str) -> Result<Value> {
    let Some(n) = model::find(g.a("nodes"), group_id) else {
        return Ok(json!({"path":settings["project"]}));
    };
    let d = &n["data"];
    if !model::create(n) {
        return Ok(json!({"path":d.s("path"),"group":d["label"]}));
    }
    let name = if d.s("nameSource") == "input" {
        settings["inputs"].s(n.s("id")).to_owned()
    } else if d.s("worktreeName").is_empty() {
        format!("wf-{}", n.s("id").chars().take(8).collect::<String>())
    } else {
        d.s("worktreeName").into()
    };
    if name.is_empty() {
        return Err(Error::new(
            400,
            format!(
                "코디네이터를 띄울 「{}」 워크트리 이름(실행 시 입력)을 넣으세요.",
                d.s("label")
            ),
        ));
    }
    let parent = model::group_of(g, n)
        .filter(|p| p["data"].s("scope") == "worktree")
        .map(|p| p["data"].s("path").into())
        .unwrap_or_else(|| workflow::resolved_parent(n, &settings["values"]));
    let repo = model::worktree_repo(g, n);
    let mut target = json!({"group":d["label"],"prepare":{"repo":if repo.is_empty(){settings.s("project")}else{&repo},"name":name}});
    if !parent.is_empty() {
        target["prepare"]["parent"] = json!(parent)
    }
    if !d.s("baseBranch").is_empty() {
        target["prepare"]["baseBranch"] = d["baseBranch"].clone()
    }
    Ok(target)
}
async fn workspace(state: &State, target: &Value, log: &str) -> Result<String> {
    if target["prepare"].is_null() {
        return Ok(target.s("path").into());
    }
    let p = state
        .bridge
        .action("prepareWorktree", json!([target["prepare"]]))
        .await?;
    let label = if p.b("created") {
        format!(
            "새로 생성{}",
            if target["prepare"].s("parent").is_empty() {
                " (부모 없음)".into()
            } else {
                format!(" (부모 {})", target["prepare"].s("parent"))
            }
        )
    } else {
        "재사용".into()
    };
    let _=state.log.append(log,&json!({"type":"note","message":format!("코디네이터 워크트리 「{}」 {label}: {}",target.s("group"),p.s("path"))}));
    Ok(p.s("path").into())
}
pub async fn start(state: Arc<State>, g: Value, mut settings: Value) -> Result<String> {
    let target = coordinator_target(&g, &settings, g.s("coordinatorGroup"))?;
    settings["coordinatorInGroup"] = json!(!target["group"].is_null());
    let prepared = prepare(&state, &g, &settings).await?;
    let id = prepared.s("logId").to_owned();
    let asynchronous = !target["prepare"].is_null();
    let log_id = id.clone();
    let launch = async move {
        let result:Result<String>=async{let worktree=workspace(&state,&target,&id).await?;let where_=if target["group"].is_null(){String::new()}else{format!(" 너는 이 워크플로의 「{}」 그룹 위치({worktree})에서 시작했다.",target.s("group"))};let r=state.bridge.action("launchCoordinator",json!([worktree,format!("{} 파일의 브리프를 읽고 그대로 수행해줘. 워크플로 \"{}\"을(를) {}회 실행하는 코디네이터 역할이다.{where_}",prepared.s("briefPath"),g.s("name"),settings.n("count"))])).await?;let terminal=r.s("terminal");let _=state.log.append(&id,&json!({"type":"coordinator","message":format!("코디네이터 기동{}{}",if target["group"].is_null(){String::new()}else{format!(" ({worktree})")},if terminal.is_empty(){String::new()}else{format!(" · {terminal}")})}));if !terminal.is_empty(){let _=state.log.patch(&id,&json!({"coordinatorTerminal":terminal}));let _=state.bridge.action("renameTerminal",json!([terminal,format!("{} · {}{} · 코디네이터",g.s("name"),prepared.s("title"),if settings.n("count")>1.{format!(" ×{}",settings.n("count"))}else{String::new()})])).await;}Ok(id.clone())}.await;
        if let Err(e) = &result {
            state.launches.lock().await.remove(prepared.s("launchKey"));
            let _=state.log.append(&id,&json!({"type":"coordinator-failed","message":format!("코디네이터 기동 실패: {}",e.message)}));
        }
        result
    };
    if asynchronous {
        tokio::spawn(async move {
            let _: Result<String> = launch.await;
        });
        Ok(log_id)
    } else {
        launch.await
    }
}
pub async fn prepare_sub(
    state: &State,
    g: &Value,
    mut settings: Value,
    parent: Value,
    input_group: &str,
) -> Result<Value> {
    let id = if g.s("coordinatorGroup").is_empty() {
        input_group
    } else {
        g.s("coordinatorGroup")
    };
    let target = coordinator_target(g, &settings, id)?;
    settings["cleanup"]["coordinator"] = json!(false);
    settings["preparedGroup"] = json!(id);
    settings["parent"] = parent;
    let prepared = prepare(state, g, &settings).await?;
    let result = workspace(state, &target, prepared.s("logId")).await;
    match result {
        Ok(worktree) => {
            if !worktree.starts_with('/') {
                return Err(Error::new(
                    503,
                    "하위 코디네이터를 띄울 워크트리 경로를 확인할 수 없습니다.",
                ));
            }
            let _=state.log.append(prepared.s("logId"),&json!({"type":"coordinator","message":format!("하위 코디네이터로 준비 · 상위 코디네이터가 워커로 띄운다 ({worktree})")}));
            Ok(
                json!({"launch":prepared["logId"],"brief":prepared["briefPath"],"worktree":worktree}),
            )
        }
        Err(e) => {
            state.launches.lock().await.remove(prepared.s("launchKey"));
            let _=state.log.append(prepared.s("logId"),&json!({"type":"coordinator-failed","message":format!("하위 코디네이터 준비 실패: {}",e.message)}));
            Err(e)
        }
    }
}
