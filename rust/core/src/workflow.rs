use crate::{JsonExt, copy_keys, entries, model, object, strings, truth, validate};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
fn fallback<'a>(s: &'a str, other: &'a str) -> &'a str {
    if s.is_empty() { other } else { s }
}
fn parent_worktree<'a>(g: &'a Value, n: &Value) -> Option<&'a Value> {
    model::group_of(g, n).filter(|p| p["data"].s("scope") == "worktree")
}
pub fn resolved_parent(n: &Value, values: &Value) -> String {
    let text = model::substitute(n["data"].s("parentPath"), values)
        .trim()
        .to_owned();
    if text.starts_with('/') && model::variable_refs(&text).is_empty() {
        text
    } else {
        String::new()
    }
}
pub fn check(name: &str, graphs: &[Value], linked: &Value) -> Result<(), String> {
    for g in graphs {
        let where_ = if graphs.len() > 1 {
            format!("'{}'의 ", g.s("name"))
        } else {
            String::new()
        };
        for n in g.a("nodes") {
            let d = &n["data"];
            let label = fallback(d.s("label"), if model::branch(n) { "분기" } else { "단계" });
            let sources: Vec<&Value> = g
                .a("edges")
                .iter()
                .filter(|e| e.s("target") == n.s("id"))
                .filter_map(|e| model::find(g.a("nodes"), e.s("source")))
                .filter(|n| model::executable(n))
                .collect();
            match name {
                "groups" if model::group(n) => {
                    let holds = g
                        .a("nodes")
                        .iter()
                        .filter(|n| model::executable(n))
                        .any(|node| {
                            let m = model::membership(g, node);
                            m.a("worktrees")
                                .iter()
                                .chain(m.get("project"))
                                .any(|p| p.s("id") == n.s("id"))
                        });
                    if !holds {
                        continue;
                    }
                    if !model::create(n) && d.s("path").is_empty() {
                        return Err(format!(
                            "{where_}'{}' 그룹의 대상을 고르세요.",
                            d.s("label")
                        ));
                    }
                    if !d.s("parentPath").trim().is_empty() && parent_worktree(g, n).is_some() {
                        return Err(format!(
                            "{where_}'{}' 그룹은 다른 워크트리 그룹 안에 있어 그 워크트리의 하위로 만들어집니다. 「부모 워크트리」를 비우세요.",
                            d.s("label")
                        ));
                    }
                    if model::create(n) && d.s("nameSource") == "agent" {
                        let Some(namer) = model::find(g.a("nodes"), d.s("nameFrom"))
                            .filter(|n| model::executable(n))
                        else {
                            return Err(format!(
                                "{where_}'{}' 그룹의 워크트리 이름을 정할 단계를 고르세요.",
                                d.s("label")
                            ));
                        };
                        if model::membership(g, namer)
                            .a("worktrees")
                            .iter()
                            .any(|p| p.s("id") == n.s("id"))
                        {
                            return Err(format!(
                                "{where_}'{}' 워크트리 이름을 정할 단계는 그 그룹 밖에 있어야 합니다.",
                                d.s("label")
                            ));
                        }
                    }
                }
                "spawns" if model::spawn(n) => {
                    let reporters: Vec<&&Value> =
                        sources.iter().filter(|n| !model::branch(n)).collect();
                    let reports = |n: &Value| {
                        n["data"].s("kind") == "worker"
                            || (n["data"].s("kind") == "script"
                                && !["", "none"].contains(&n["data"].s("parse")))
                    };
                    if sources.is_empty()
                        || reporters.len() > 1
                        || (reporters.len() == 1 && !reports(reporters[0]))
                    {
                        return Err(format!(
                            "{where_}'{}' 링크가 항목마다 따로 실행하려면 항목 목록을 보고할 워커 하나만(또는 출력을 읽는 스크립트 드라이버 하나만) 앞에 연결해야 합니다. 분기 출력에서 오는 연결은 빈 항목으로 더할 수 있습니다.",
                            fallback(d.s("label"), "링크")
                        ));
                    }
                    if sources.len() > 1 && d.s("join") != "any" {
                        return Err(format!(
                            "{where_}'{}' 링크에 들어오는 연결이 여럿이면 합류 방식을 「하나라도 오면 진행」으로 두세요.",
                            fallback(d.s("label"), "링크")
                        ));
                    }
                    if let Some(target) = linked.get(d.s("workflowId")) {
                        let count = target
                            .a("nodes")
                            .iter()
                            .filter(|n| model::create(n) && n["data"].s("nameSource") == "input")
                            .count();
                        if count != 1 {
                            return Err(format!(
                                "{where_}'{}' 링크의 대상 '{}'에는 항목을 받을 「실행 시 입력」 워크트리 그룹이 정확히 하나 있어야 합니다(지금 {count}개).",
                                fallback(d.s("label"), "링크"),
                                target.s("name")
                            ));
                        }
                    }
                }
                "loops" if d.s("kind") == "workflow" && !model::spawn(n) => {
                    if let Some(target) = linked.get(d.s("workflowId")) {
                        if target.a("edges").iter().any(|e| truth(&e["loop"])) {
                            return Err(format!(
                                "'{}' 링크가 펼칠 '{}'에 되돌아가기 연결이 있습니다. 반복하는 워크플로는 「항목마다 따로 실행」으로 연결하거나 링크 없이 실행하세요.",
                                fallback(d.s("label"), "링크"),
                                target.s("name")
                            ));
                        }
                    }
                }
                "variables" => {
                    let declared: HashSet<&str> =
                        g.a("variables").iter().map(|v| v.s("key")).collect();
                    if model::create(n) && !d.s("parentPath").is_empty() {
                        let unknown: Vec<String> = model::variable_refs(d.s("parentPath"))
                            .into_iter()
                            .filter(|k| !declared.contains(k.as_str()))
                            .map(|k| format!("{{{{{k}}}}}"))
                            .collect();
                        if !unknown.is_empty() {
                            return Err(format!(
                                "{where_}'{}' 그룹의 부모 워크트리 {} 이(가) 워크플로 설정값에 없습니다.",
                                d.s("label"),
                                unknown.join(", ")
                            ));
                        }
                    }
                    if model::executable(n) {
                        let unknown: Vec<String> = model::variable_refs(d.s("description"))
                            .into_iter()
                            .filter(|k| !declared.contains(k.as_str()))
                            .map(|k| format!("{{{{{k}}}}}"))
                            .collect();
                        if !unknown.is_empty() {
                            return Err(format!(
                                "{where_}'{label}' 지침의 {} 이(가) 워크플로 설정값에 없습니다. 설정값을 추가하거나 지침을 고치세요.",
                                unknown.join(", ")
                            ));
                        }
                    }
                }
                "branches" => {
                    if model::branch(n) {
                        if d.a("outputs").len() < 2 {
                            return Err(format!(
                                "{where_}'{label}' 분기에 출력을 두 개 이상 만드세요."
                            ));
                        }
                        if d.a("outputs")
                            .iter()
                            .any(|o| o.s("label").trim().is_empty())
                        {
                            return Err(format!(
                                "{where_}'{label}' 분기의 출력마다 조건을 적으세요."
                            ));
                        }
                        if sources.is_empty() {
                            return Err(format!(
                                "{where_}'{label}' 분기 앞에 판정 근거가 될 단계를 연결하세요."
                            ));
                        }
                        let reports = |n: &Value| {
                            n["data"].s("kind") == "worker"
                                || (n["data"].s("kind") == "script"
                                    && !["", "none"].contains(&n["data"].s("parse")))
                        };
                        if fallback(d.s("judge"), "previous") == "previous"
                            && (sources.len() != 1 || !reports(sources[0]))
                        {
                            return Err(format!(
                                "{where_}'{label}' 분기를 직전 단계 워커가 판정하려면 앞에 워커 하나만(또는 JSON 줄로 판정을 내는 스크립트 드라이버 하나만) 연결해야 합니다."
                            ));
                        }
                    }
                    if d.s("kind") == "gate"
                        && d.s("asker") == "previous"
                        && (sources.len() != 1 || sources[0]["data"].s("kind") != "worker")
                    {
                        return Err(format!(
                            "{where_}'{}' 게이트를 직전 워커 터미널에서 물으려면 앞에 워커 하나만 연결해야 합니다.",
                            fallback(d.s("label"), "게이트")
                        ));
                    }
                }
                "scripts" if d.s("kind") == "script" => {
                    let label = fallback(d.s("label"), "스크립트 드라이버");
                    if d.s("command").trim().is_empty() {
                        return Err(format!(
                            "{where_}'{label}' 스크립트 드라이버에 실행할 명령을 적으세요."
                        ));
                    }
                    if d.s("parse") == "regex" && d.s("itemPattern").is_empty() {
                        return Err(format!(
                            "{where_}'{label}' 스크립트 드라이버의 항목 정규식을 적으세요."
                        ));
                    }
                }
                _ => {}
            }
        }
        if name == "sessions" {
            let mut sessions: HashMap<&str, HashSet<&str>> = HashMap::new();
            for n in g.a("nodes") {
                let key = model::session(n);
                if !key.is_empty() {
                    sessions.entry(key).or_default().insert(n.s("parentId"));
                }
            }
            for (key, parents) in sessions {
                if parents.len() > 1 {
                    return Err(format!(
                        "{where_}세션 '{key}' 의 단계가 서로 다른 워크트리 그룹에 있습니다. 한 세션의 단계는 같은 그룹에 둡니다."
                    ));
                }
            }
        }
    }
    if name == "coordinator" {
        let Some(g) = graphs.first() else {
            return Ok(());
        };
        if g.s("coordinatorGroup").is_empty() {
            return Ok(());
        }
        let Some(n) = model::find(g.a("nodes"), g.s("coordinatorGroup"))
            .filter(|n| model::group(n) && ["worktree", "project"].contains(&n["data"].s("scope")))
        else {
            return Err("코디네이터 위치로 고른 프로젝트·워크트리 그룹이 없습니다.".into());
        };
        let d = &n["data"];
        let name = format!("'{}'", d.s("label"));
        if !model::create(n) {
            if d.s("path").is_empty() {
                return Err(format!("{name} 그룹의 대상을 고르세요."));
            }
            return Ok(());
        }
        if d.s("nameSource") == "agent" {
            return Err(format!(
                "코디네이터 위치 {name} 의 이름을 이전 단계가 정하면 코디네이터를 띄우기 전에 만들 수 없습니다. 이름을 직접 지정하거나 실행 시 입력으로 받으세요."
            ));
        }
        if d.b("perExecution") {
            return Err(format!(
                "코디네이터 위치 {name} 는 「실행마다 따로 만들기」를 끄세요. 코디네이터는 하나입니다."
            ));
        }
        let mut parent = parent_worktree(g, n);
        for _ in 0..=4 {
            let Some(p) = parent else { break };
            if model::create(p) {
                return Err(format!(
                    "코디네이터 위치 {name} 가 실행 중에 만들어질 '{}' 안에 있습니다. 바깥 그룹을 기존 워크트리로 고르거나 「부모 워크트리」를 쓰세요.",
                    p["data"].s("label")
                ));
            }
            parent = parent_worktree(g, p)
        }
    }
    Ok(())
}
pub struct Context<'a> {
    pub linked: &'a Value,
    pub project: &'a str,
    pub inputs: &'a Value,
    pub values: Value,
    pub worktrees: Vec<Value>,
    pub prepared: &'a str,
    pub instructions: Option<String>,
}
fn group_location(n: &Value, prefix: &str) -> String {
    if model::create(n) {
        format!("new-worktree:{prefix}{}", n.s("id"))
    } else {
        n["data"].s("path").into()
    }
}
pub fn stages(
    g: &Value,
    ctx: &mut Context,
    fallback_location: &str,
    prefix: &str,
) -> Result<Vec<Value>, String> {
    let nodes = g.a("nodes");
    let mut namers: HashMap<String, Vec<String>> = HashMap::new();
    let groups = model::order_nodes(
        &nodes
            .iter()
            .filter(|n| model::group(n) && n["data"].s("scope") == "worktree")
            .cloned()
            .collect::<Vec<_>>(),
    );
    for n in &groups {
        let d = &n["data"];
        let parent = parent_worktree(g, n);
        let mut base = json!({"location":group_location(n,prefix),"group":d["label"],"repo":fallback(&model::worktree_repo(g,n),ctx.project)});
        if let Some(parent) = parent {
            base["parent"] = json!(group_location(parent, prefix))
        }
        if prefix.is_empty() && ctx.prepared == n.s("id") {
            base["prepared"] = json!(true)
        }
        if !model::create(n) {
            base["mode"] = json!("existing");
            let mut existing = json!({"path":d.s("path")});
            for (k, from) in [("name", "worktreeName"), ("branch", "branch")] {
                if !d.s(from).is_empty() {
                    existing[k] = d[from].clone()
                }
            }
            base["existing"] = existing;
            ctx.worktrees.push(base);
            continue;
        }
        let source = fallback(d.s("nameSource"), "fixed");
        let mut name = json!({"source":source});
        match source {
            "agent" => {
                name["fromStage"] = json!(format!("{prefix}{}", d.s("nameFrom")));
                if !d.s("nameFrom").is_empty() {
                    namers
                        .entry(d.s("nameFrom").into())
                        .or_default()
                        .push(base.s("location").into());
                }
            }
            "input" => {
                if !ctx.inputs.s(&format!("{prefix}{}", n.s("id"))).is_empty() {
                    name["value"] = ctx.inputs[format!("{prefix}{}", n.s("id"))].clone()
                }
                if !d.s("inputPrompt").is_empty() {
                    name["prompt"] = d["inputPrompt"].clone()
                }
            }
            _ => {
                name["value"] = json!(if d.s("worktreeName").is_empty() {
                    format!("wf-{}", n.s("id").chars().take(8).collect::<String>())
                } else {
                    d.s("worktreeName").into()
                })
            }
        }
        base["mode"] = json!("create");
        base["name"] = name;
        base["perExecution"] = json!(d.b("perExecution"));
        if !d.s("baseBranch").is_empty() {
            base["baseBranch"] = d["baseBranch"].clone()
        }
        if parent.is_none() {
            let path = resolved_parent(n, &ctx.values);
            if !path.is_empty() {
                base["parentPath"] = json!(path)
            }
        }
        ctx.worktrees.push(base);
    }
    let executable: Vec<String> = nodes
        .iter()
        .filter(|n| model::executable(n))
        .map(|n| n.s("id").into())
        .collect();
    let edges: Vec<Value> = g
        .a("edges")
        .iter()
        .filter(|e| {
            e["loop"].is_null()
                && executable.iter().any(|id| id == e.s("source"))
                && executable.iter().any(|id| id == e.s("target"))
        })
        .cloned()
        .collect();
    let order = strings(&model::topological(&executable, &edges)["order"]);
    let wave = model::waves(&order, &edges);
    let mut values = object();
    for v in g.a("variables") {
        values[v.s("key")] = json!("")
    }
    for (k, v) in entries(&ctx.values) {
        values[k] = v
    }
    let mut out = vec![];
    for id in &order {
        let n = model::find(nodes, id).unwrap();
        let d = &n["data"];
        let m = model::membership(g, n);
        let location = m
            .a("worktrees")
            .last()
            .map(|n| group_location(n, prefix))
            .unwrap_or_else(|| fallback(m["project"]["data"].s("path"), fallback_location).into());
        let mut stage = json!({"nodeId":format!("{prefix}{id}"),"label":d["label"],"kind":d["kind"],"instructions":model::substitute(d.s("description"),&values),"location":location,"wave":wave[id],"after":edges.iter().filter(|e|e.s("target")==id).map(|e|{let source=model::find(nodes,e.s("source")).unwrap();let output=if source["data"].s("kind")=="gate"{Some(json!({"id":"approve","label":"통과"}))}else if model::branch(source){source["data"].a("outputs").iter().find(|o|o.s("id")==e.s("sourceHandle")).cloned()}else{None};let mut a=json!({"nodeId":format!("{prefix}{}",e.s("source"))});if let Some(output)=&output{a["output"]=output["id"].clone()}if !e.s("label").is_empty()||output.is_some(){a["condition"]=json!(fallback(e.s("label"),output.as_ref().map(|o|o.s("label")).unwrap_or("")))}a}).collect::<Vec<_>>()});
        if let Some(dir) = &ctx.instructions {
            if d.s("kind") == "worker" && !d.s("description").trim().is_empty() {
                stage["instructionsFile"] = json!(format!("{dir}/{prefix}{id}.md"))
            }
        }
        if model::branch(n) {
            let loops:Vec<Value>=g.a("edges").iter().filter(|e|!e["loop"].is_null()&&e.s("source")==id&&!e.s("sourceHandle").is_empty()).map(|e|{let body=model::loop_body(g.a("edges"),e);json!({"edge":e["id"],"output":e["sourceHandle"],"to":format!("{prefix}{}",e.s("target")),"max":e["loop"]["max"],"exit":e["loop"]["exit"],"body":order.iter().filter(|id|body.contains(id)).map(|id|format!("{prefix}{id}")).collect::<Vec<_>>()})}).collect();
            stage["branch"] = json!({"mode":fallback(d.s("mode"),"exclusive"),"judge":fallback(d.s("judge"),"previous"),"outputs":d.a("outputs")});
            if !loops.is_empty() {
                stage["branch"]["loops"] = json!(loops)
            }
        }
        if d.s("kind") == "gate" {
            stage["branch"] = json!({"mode":"exclusive","judge":match d.s("asker"){"previous"=>"previous","auto"=>"auto",_=>"user"},"outputs":model::gate_outputs()})
        }
        if d.s("join") == "any" {
            stage["join"] = json!("any")
        }
        let targets: Vec<&Value> = edges
            .iter()
            .filter(|e| e.s("source") == id)
            .filter_map(|e| model::find(nodes, e.s("target")))
            .collect();
        let decides:Vec<Value>=targets.iter().filter(|t|(model::branch(t)&&fallback(t["data"].s("judge"),"previous")=="previous")||(t["data"].s("kind")=="gate"&&t["data"].s("asker")=="previous")).map(|t|{let td=&t["data"];if td.s("kind")=="gate"{json!({"nodeId":format!("{prefix}{}",t.s("id")),"mode":"exclusive","outputs":model::gate_outputs(),"ask":fallback(td.s("description"),fallback(td.s("label"),"진행해도 될까요?"))})}else{json!({"nodeId":format!("{prefix}{}",t.s("id")),"mode":fallback(td.s("mode"),"exclusive"),"outputs":td.a("outputs")})}}).collect();
        if !decides.is_empty() {
            stage["decides"] = json!(decides)
        }
        if let Some(names) = namers.get(id) {
            stage["namesWorktree"] = json!(names)
        }
        if model::launches(n) {
            if !d["fanout"].is_null() {
                let fan = &d["fanout"];
                let from_setting: Vec<String> = ctx
                    .values
                    .s(fan.s("variable"))
                    .split(|c: char| c.is_whitespace() || c == ',')
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect();
                let models = if from_setting.is_empty() {
                    strings(&fan["models"])
                } else {
                    from_setting
                };
                let where_ = format!("'{}' 의 모델별 병렬 워커", fallback(d.s("label"), id));
                if let Some(bad) = models.iter().find(|s| !validate::valid_model(s)) {
                    return Err(format!(
                        "{where_} 모델 id '{}' 가 올바르지 않습니다.",
                        bad.chars().take(40).collect::<String>()
                    ));
                }
                if models.is_empty() && ctx.instructions.is_some() {
                    return Err(format!(
                        "{where_}에 모델이 없습니다. 노드에 모델을 넣거나 설정값 '{}' 를 채우세요.",
                        fan.s("variable")
                    ));
                }
                let mut seen = HashMap::new();
                stage["fanout"]=json!(models.iter().map(|m|{let count=seen.entry(m).or_insert(0);*count+=1;json!({"name":if *count==1{m.clone()}else{format!("{m}-{count}")},"model":m,"agent":model::agent(m)})}).collect::<Vec<_>>())
            } else {
                let m = fallback(d.s("workerModel"), model::DEFAULT_MODEL);
                stage["model"] = json!(m);
                stage["agent"] = json!(model::agent(m))
            }
            if !d.s("effort").is_empty() {
                stage["effort"] = d["effort"].clone()
            }
        }
        if !model::session(n).is_empty() {
            stage["session"] = json!(format!("{prefix}{}", model::session(n)))
        }
        if let Some(target) = ctx
            .linked
            .get(d.s("workflowId"))
            .filter(|_| d.s("kind") == "workflow")
        {
            if model::spawn(n) {
                let input = target
                    .a("nodes")
                    .iter()
                    .find(|n| model::create(n) && n["data"].s("nameSource") == "input")
                    .map(|n| n.s("id"))
                    .unwrap_or("");
                stage["spawn"] =
                    json!({"workflowId":target["id"],"name":target["name"],"input":input});
                if d.s("spawnAs") == "subcoordinator" {
                    stage["spawn"]["as"] = json!("subcoordinator");
                    stage["spawn"]["title"] =
                        json!(target.s("name").chars().take(24).collect::<String>())
                }
            } else {
                let old = ctx.values.clone();
                let mut sub_values =
                    model::resolve_variables(&target["variables"], &Value::Null)["values"].clone();
                for (k, v) in entries(&ctx.values) {
                    sub_values[k] = v
                }
                ctx.values = sub_values;
                let sub = stages(target, ctx, &location, &format!("{prefix}{id}."))?;
                ctx.values = old;
                stage["workflow"] = json!({"id":target["id"],"name":target["name"],"wait":d.s("linkMode")!="start","stages":sub})
            }
        }
        let feeds: Vec<String> = targets
            .iter()
            .filter(|n| model::spawn(n))
            .map(|n| format!("{prefix}{}", n.s("id")))
            .collect();
        if !feeds.is_empty() {
            stage["reportsItems"] = json!(feeds)
        }
        if d.s("kind") == "script" {
            let mut script = json!({"command":model::substitute(d.s("command"),&values),"parse":fallback(d.s("parse"),"none"),"detach":d.b("detach"),"timeoutSec":d.get("timeoutSec").cloned().unwrap_or(json!(if d.b("detach"){86400}else{600}))});
            if d.s("parse") == "regex" && !d.s("itemPattern").is_empty() {
                script["itemPattern"] = d["itemPattern"].clone()
            }
            stage["script"] = script
        }
        out.push(stage);
    }
    Ok(out)
}
pub fn flatten(stages: &[Value]) -> Vec<Value> {
    let mut sinks = object();
    let mut expanded = object();
    fn resolve(after: &[Value], sinks: &Value) -> Vec<Value> {
        after
            .iter()
            .flat_map(|a| {
                if let Some(found) = sinks.get(a.s("nodeId")) {
                    found.list().to_vec()
                } else {
                    let mut n = json!({"id":a["nodeId"]});
                    if !a.s("output").is_empty() {
                        n["output"] = a["output"].clone()
                    }
                    vec![n]
                }
            })
            .collect()
    }
    for s in stages.iter().filter(|s| !s["workflow"].is_null()) {
        let sub = flatten(s["workflow"].a("stages"));
        let referenced: HashSet<&str> = sub
            .iter()
            .flat_map(|s| s.a("after").iter().map(|a| a.s("id")))
            .collect();
        sinks[s.s("nodeId")] = if s["workflow"].b("wait") {
            json!(
                sub.iter()
                    .filter(|s| !referenced.contains(s.s("id")))
                    .map(|s| json!({"id":s["id"]}))
                    .collect::<Vec<_>>()
            )
        } else {
            json!(resolve(s.a("after"), &sinks))
        };
        expanded[s.s("nodeId")] = json!(sub)
    }
    let mut out = vec![];
    for s in stages {
        if !s["workflow"].is_null() {
            for item in expanded[s.s("nodeId")].list() {
                let mut item = item.clone();
                if item.a("after").is_empty() {
                    item["after"] = json!(resolve(s.a("after"), &sinks))
                }
                out.push(item)
            }
        } else {
            let mut item = json!({"id":s["nodeId"],"after":resolve(s.a("after"),&sinks),"label":s["label"],"question":s["instructions"]});
            if !s["branch"].is_null() {
                item["branch"] = json!({"mode":s["branch"]["mode"],"outputs":s["branch"].a("outputs").iter().map(|o|o["id"].clone()).collect::<Vec<_>>()});
                item["judge"] = s["branch"]["judge"].clone();
                item["outputLabels"] = Value::Object(
                    s["branch"]
                        .a("outputs")
                        .iter()
                        .map(|o| (o.s("id").to_owned(), o["label"].clone()))
                        .collect(),
                );
                if !s["branch"]["loops"].is_null() {
                    item["loops"] = s["branch"]["loops"].clone()
                }
            }
            if s.s("kind") == "gate" {
                item["veto"] = json!(["reject"])
            }
            copy_keys(&mut item, s, &["join"]);
            out.push(item)
        }
    }
    out
}
pub fn flow(g: &Value, linked: &Value) -> Result<Value, String> {
    let mut ctx = Context {
        linked,
        project: "",
        inputs: &Value::Null,
        values: model::resolve_variables(&g["variables"], &Value::Null)["values"].clone(),
        worktrees: vec![],
        prepared: "",
        instructions: None,
    };
    Ok(json!(flatten(&stages(g, &mut ctx, "", "")?)))
}
pub fn overview_executions(g: &Value) -> Vec<Value> {
    if !g.a("executions").is_empty() {
        return g.a("executions").to_vec();
    }
    let bindings: serde_json::Map<String, Value> = g
        .a("nodes")
        .iter()
        .filter(|n| model::executable(n) && !n["data"].s("taskId").is_empty())
        .map(|n| (n.s("id").into(), n["data"]["taskId"].clone()))
        .collect();
    if !g.s("runId").is_empty() && !bindings.is_empty() {
        vec![json!({"id":"","label":"연결된 Run","bindings":bindings})]
    } else {
        vec![]
    }
}
pub fn dispatch(op: &str, a: &Value) -> Result<Value, String> {
    match op {
        "flowOf" => flow(&a[0], &a[1]),
        "overviewExecutions" => Ok(json!(overview_executions(&a[0]))),
        "resolvedParentPath" => Ok(json!(resolved_parent(&a[0], &a[1]))),
        _ if op.starts_with("check") => {
            let name = match op {
                "checkGroups" => "groups",
                "checkBranches" => "branches",
                "checkSpawns" => "spawns",
                "checkScripts" => "scripts",
                "checkSessions" => "sessions",
                "checkVariables" => "variables",
                "checkLoops" => "loops",
                "checkCoordinatorGroup" => "coordinator",
                _ => return Err(format!("알 수 없는 계산: {op}")),
            };
            let graphs = if name == "coordinator" {
                vec![a[0].clone()]
            } else {
                a[0].list().to_vec()
            };
            check(name, &graphs, &a[1])?;
            Ok(Value::Null)
        }
        _ => Err(format!("알 수 없는 계산: {op}")),
    }
}
