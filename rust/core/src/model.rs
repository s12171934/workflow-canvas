use crate::{JsonExt, copy_keys, drop_keys, entries, has, object, strings, truth};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
pub const MODELS: [&str; 4] = [
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-fable-5-2",
];
pub const TALLY: [&str; 8] = [
    "running",
    "blocked",
    "failed",
    "unknown",
    "pending",
    "completed",
    "skipped",
    "unbound",
];
pub fn executable(n: &Value) -> bool {
    ["worker", "gate", "workflow", "branch", "script"].contains(&n["data"].s("kind"))
}
pub fn group(n: &Value) -> bool {
    n["data"].s("kind") == "group"
}
pub fn frame(n: &Value) -> bool {
    n["data"].s("kind") == "frame"
}
pub fn branch(n: &Value) -> bool {
    n["data"].s("kind") == "branch"
}
pub fn create(n: &Value) -> bool {
    group(n) && n["data"].s("scope") == "worktree" && n["data"].s("worktreeMode") == "create"
}
pub fn spawn(n: &Value) -> bool {
    n["data"].s("kind") == "workflow" && n["data"].s("linkMode") == "spawn"
}
pub fn launches(n: &Value) -> bool {
    n["data"].s("kind") == "worker" || (branch(n) && n["data"].s("judge") == "worker")
}
pub fn session(n: &Value) -> &str {
    if n["data"].s("kind") == "worker" && n["data"]["fanout"].is_null() {
        n["data"].s("session")
    } else {
        ""
    }
}
pub fn agent(s: &str) -> &'static str {
    if s.starts_with("gpt")
        || s.starts_with("codex")
        || (s.starts_with('o') && s.chars().nth(1).is_some_and(|c| c.is_ascii_digit()))
    {
        "codex"
    } else {
        "claude"
    }
}
pub fn gate_outputs() -> Value {
    json!([{"id":"approve","label":"통과"},{"id":"reject","label":"거절"}])
}
pub fn status_label(s: &str) -> &str {
    match s {
        "unbound" => "미연결",
        "pending" => "대기",
        "running" => "실행 중",
        "blocked" => "확인 필요",
        "completed" => "완료",
        "failed" => "실패",
        "skipped" => "건너뜀",
        _ => "상태 미확인",
    }
}
pub fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|v| seen.insert(v.clone()))
        .collect()
}
pub fn find<'a>(values: &'a [Value], id: &str) -> Option<&'a Value> {
    values.iter().find(|v| v.s("id") == id)
}
pub fn group_of<'a>(g: &'a Value, n: &Value) -> Option<&'a Value> {
    find(g.a("nodes"), n.s("parentId")).filter(|v| group(v))
}
pub fn membership(g: &Value, n: &Value) -> Value {
    let mut out = json!({"worktrees":[]});
    let mut current = group_of(g, n);
    for _ in 0..=4 {
        let Some(p) = current else { break };
        if p["data"].s("scope") == "worktree" {
            out["worktrees"]
                .as_array_mut()
                .unwrap()
                .insert(0, p.clone())
        } else if out["project"].is_null() {
            out["project"] = p.clone()
        }
        current = group_of(g, p);
    }
    out
}
pub fn worktree_repo(g: &Value, n: &Value) -> String {
    let mut current = Some(n);
    for _ in 0..=4 {
        let Some(p) = current else { break };
        let value = if p["data"].s("scope") == "worktree" {
            p["data"].s("repoPath")
        } else {
            p["data"].s("path")
        };
        if !value.is_empty() {
            return value.into();
        }
        current = group_of(g, p);
    }
    String::new()
}
pub fn order_nodes(nodes: &[Value]) -> Vec<Value> {
    let depth = |n: &Value| {
        let mut d = 0;
        let mut p = n.s("parentId");
        while !p.is_empty() && d < 5 {
            d += 1;
            p = find(nodes, p).map(|v| v.s("parentId")).unwrap_or("");
        }
        d as f64
    };
    let rank = |n: &Value| {
        if frame(n) {
            if n.s("parentId").is_empty() {
                -1.
            } else {
                depth(n) - 0.5
            }
        } else if group(n) {
            depth(n)
        } else {
            6.
        }
    };
    let mut out = nodes.to_vec();
    out.sort_by(|a, b| rank(a).total_cmp(&rank(b)));
    out
}
pub fn task_status(task: &Value, workers: &[Value]) -> &'static str {
    match task.s("status") {
        "completed" | "succeeded" | "done" => "completed",
        "failed" | "cancelled" | "canceled" | "abandoned" => "failed",
        "blocked" | "waiting" | "waiting_for_input" | "awaiting_approval" => "blocked",
        "pending" | "queued" | "todo" | "ready" => "pending",
        "running" | "in_progress" | "in-progress" | "dispatched" | "active" => {
            let w = workers.iter().find(|w| w.s("taskId") == task.s("id"));
            if w.is_some_and(|w| ["unverifiable", "exited"].contains(&w.s("liveness"))) {
                "unknown"
            } else if w.is_some_and(|w| {
                ["waiting", "blocked", "question", "escalation"].contains(&w.s("stage"))
            }) {
                "blocked"
            } else {
                "running"
            }
        }
        _ => "unknown",
    }
}
pub fn aggregate(statuses: &[Value]) -> &'static str {
    if !statuses.iter().any(|s| s.text() != "unbound") {
        return "unbound";
    }
    for s in [
        "failed",
        "blocked",
        "unknown",
        "running",
        "pending",
        "completed",
        "skipped",
    ] {
        if has(&Value::Array(statuses.to_vec()), s) {
            return s;
        }
    }
    "unknown"
}
pub fn finished(statuses: &[Value]) -> bool {
    !statuses
        .iter()
        .any(|v| ["running", "blocked", "unknown", "failed", "pending"].contains(&v.text()))
        && statuses.iter().any(|v| v == "completed")
}
pub fn binding_status(id: &str, snapshot: &Value, stale: bool) -> &'static str {
    if id.is_empty() {
        "unbound"
    } else if stale {
        "unknown"
    } else {
        if snapshot.get("_taskLookup").is_some() {
            let worker = snapshot["_workerLookup"].get(id);
            task_status(
                &snapshot["_taskLookup"][id],
                worker.map(std::slice::from_ref).unwrap_or(&[]),
            )
        } else {
            task_status(
                find(snapshot.a("tasks"), id).unwrap_or(&Value::Null),
                snapshot.a("workers"),
            )
        }
    }
}
pub fn indexed_snapshot(snapshot: &Value) -> Value {
    if snapshot.is_null() {
        return Value::Null;
    }
    let mut indexed = snapshot.clone();
    indexed["_taskLookup"] = Value::Object(
        snapshot
            .a("tasks")
            .iter()
            .map(|t| (t.s("id").to_owned(), t.clone()))
            .collect(),
    );
    let mut workers = object();
    for worker in snapshot.a("workers") {
        if workers.get(worker.s("taskId")).is_none() {
            workers[worker.s("taskId")] = worker.clone();
        }
    }
    indexed["_workerLookup"] = workers;
    indexed
}
pub fn node_status(n: &Value, e: &Value, snapshot: &Value, stale: bool) -> &'static str {
    let id = n.s("id");
    if n["data"].s("kind") == "workflow" && !spawn(n) {
        let statuses: Vec<Value> = entries(&e["links"][id])
            .iter()
            .map(|(path, task)| {
                json!(if has(&e["skipped"], &format!("{id}.{path}")) {
                    "skipped"
                } else {
                    binding_status(task.text(), snapshot, stale)
                })
            })
            .collect();
        if !statuses.is_empty() && statuses.iter().all(|s| s == "skipped") {
            return "skipped";
        }
        return aggregate(
            &statuses
                .into_iter()
                .filter(|s| s != "skipped")
                .collect::<Vec<_>>(),
        );
    }
    if has(&e["skipped"], id) {
        "skipped"
    } else {
        binding_status(e["bindings"].s(id), snapshot, stale)
    }
}
pub fn node_task(n: &Value, e: &Value, snapshot: &Value, stale: bool) -> String {
    let id = n.s("id");
    if n["data"].s("kind") != "workflow" || spawn(n) {
        return e["bindings"].s(id).into();
    }
    let tasks = entries(&e["links"][id]);
    tasks
        .iter()
        .find(|(_, t)| {
            ["running", "blocked", "unknown"].contains(&binding_status(t.text(), snapshot, stale))
        })
        .or(tasks.first())
        .map(|(_, t)| t.text().into())
        .unwrap_or_default()
}
pub fn tally(statuses: &[Value]) -> Value {
    json!(
        TALLY
            .iter()
            .filter_map(|&s| {
                let n = statuses.iter().filter(|v| v.text() == s).count();
                (n > 0).then(|| json!({"status":s,"count":n}))
            })
            .collect::<Vec<_>>()
    )
}
pub fn stage_round(e: &Value, id: &str) -> usize {
    1 + e
        .a("history")
        .iter()
        .filter(|p| has(&p["nodes"], id))
        .count()
}
pub fn execution_run<'a>(g: &'a Value, e: &'a Value) -> &'a str {
    if e.s("runId").is_empty() {
        g.s("runId")
    } else {
        e.s("runId")
    }
}
pub fn statuses(nodes: &[Value], e: &Value, s: &Value, stale: bool) -> Vec<Value> {
    let indexed = indexed_snapshot(s);
    let s = &indexed;
    nodes
        .iter()
        .filter(|n| executable(n))
        .map(|n| json!(node_status(n, e, s, stale)))
        .collect()
}
pub fn summary(nodes: &[Value], e: &Value, s: &Value, stale: bool) -> Value {
    let indexed = indexed_snapshot(s);
    let s = &indexed;
    let stages: Vec<&Value> = nodes.iter().filter(|n| executable(n)).collect();
    let statuses: Vec<Value> = stages
        .iter()
        .map(|n| json!(node_status(n, e, s, stale)))
        .collect();
    let names = |status: &str| {
        stages
            .iter()
            .zip(&statuses)
            .filter(|(_, s)| s.text() == status)
            .map(|(n, _)| {
                if n["data"].s("label").is_empty() {
                    "이름 없는 단계"
                } else {
                    n["data"].s("label")
                }
            })
            .collect::<Vec<_>>()
    };
    json!({"total":stages.len(),"done":statuses.iter().filter(|s|["completed","skipped"].contains(&s.text())).count(),"tally":tally(&statuses),"running":names("running"),"blocked":names("blocked"),"failed":names("failed")})
}
pub fn project_nodes(
    nodes: &[Value],
    snapshot: &Value,
    stale: bool,
    executions: &[Value],
    view: &str,
    visible: Option<&Value>,
) -> Value {
    let indexed = indexed_snapshot(snapshot);
    let snapshot = &indexed;
    let selected = find(executions, view).filter(|_| view != "all");
    json!(nodes.iter().map(|n|{let mut out=n.clone();let d=&mut out["data"];drop_keys(d,&["status","runs","activeTaskId","decision","spawned","round","live"]);if !executable(n){return out}let runs:Vec<Value>=executions.iter().map(|e|{let mut r=json!({"id":e["id"],"label":e["label"],"status":node_status(n,e,snapshot,stale)});let task=node_task(n,e,snapshot,stale);if !task.is_empty(){r["taskId"]=json!(task)}r}).collect();let shown:Vec<Value>=runs.iter().filter(|r|visible.is_none_or(|v|has(v,r.s("id")))).cloned().collect();let task=if let Some(e)=selected{node_task(n,e,snapshot,stale)}else if view=="all"{String::new()}else{n["data"].s("taskId").into()};let w=snapshot["_workerLookup"].get(&task);let t=snapshot["_taskLookup"].get(&task);let status=if view=="all"{aggregate(&if shown.is_empty(){&runs}else{&shown}.iter().map(|r|r["status"].clone()).collect::<Vec<_>>())}else if let Some(e)=selected{node_status(n,e,snapshot,stale)}else{binding_status(&task,snapshot,stale)};d["status"]=json!(status);if view=="all"{d["runs"]=json!(shown)}if !task.is_empty(){d["activeTaskId"]=json!(task)}let live=if view=="all"{shown.iter().filter(|r|r.s("status")=="running").count()}else{usize::from(status=="running")};if live>0{d["live"]=json!(live)}let active:Vec<&Value>=executions.iter().filter(|e|selected.is_some_and(|x|x.s("id")==e.s("id"))||(view=="all"&&visible.is_none_or(|v|has(v,e.s("id"))))).collect();if spawn(n){let requested:Vec<Value>=active.iter().flat_map(|e|e["spawned"][n.s("id")].list()).cloned().collect();if !requested.is_empty(){d["spawned"]=json!(requested)}}let round=active.iter().map(|e|stage_round(e,n.s("id"))).max().unwrap_or(1);if round>1{d["round"]=json!(round)}if branch(n){if let Some(e)=selected{if !e["decisions"][n.s("id")].is_null(){d["decision"]=e["decisions"][n.s("id")].clone()}}}drop_keys(d,&["agent","model","detail"]);if let Some(w)=w{copy_keys(d,&json!({"agent":w["provider"],"model":w["model"]}),&["agent","model"])}if stale{d["detail"]=json!("Orca 상태를 새로 확인할 수 없습니다.")}else if let Some(t)=t{d["detail"]=t["status"].clone()}out}).collect::<Vec<_>>())
}
pub fn topological(ids: &[String], edges: &[Value]) -> Value {
    let mut degree: HashMap<String, usize> = ids.iter().map(|i| (i.clone(), 0)).collect();
    let mut next: HashMap<String, Vec<String>> = ids.iter().map(|i| (i.clone(), vec![])).collect();
    let mut prev = next.clone();
    for e in edges {
        if degree.contains_key(e.s("source")) && degree.contains_key(e.s("target")) {
            next.get_mut(e.s("source"))
                .unwrap()
                .push(e.s("target").into());
            prev.get_mut(e.s("target"))
                .unwrap()
                .push(e.s("source").into());
            *degree.get_mut(e.s("target")).unwrap() += 1;
        }
    }
    let mut queue: VecDeque<String> = ids.iter().filter(|i| degree[*i] == 0).cloned().collect();
    let mut order = vec![];
    while let Some(id) = queue.pop_front() {
        order.push(id.clone());
        for target in &next[&id] {
            let d = degree.get_mut(target).unwrap();
            *d -= 1;
            if *d == 0 {
                queue.push_back(target.clone())
            }
        }
    }
    if order.len() == ids.len() {
        return json!({"order":order});
    }
    let rest: Vec<&String> = ids.iter().filter(|i| !order.contains(i)).collect();
    let mut walk = vec![];
    let mut current = rest[0].clone();
    while !walk.contains(&current) {
        walk.push(current.clone());
        current = prev[&current]
            .iter()
            .find(|i| rest.contains(i))
            .unwrap()
            .clone();
    }
    let at = walk.iter().position(|i| i == &current).unwrap();
    let mut cycle: Vec<String> = walk[at..].iter().rev().cloned().collect();
    let first = ids.iter().find(|i| cycle.contains(i)).unwrap();
    let start = cycle.iter().position(|i| i == first).unwrap();
    cycle.rotate_left(start);
    cycle.push(cycle[0].clone());
    json!({"order":order,"cycle":cycle})
}
pub fn waves(order: &[String], edges: &[Value]) -> Value {
    let mut out = object();
    for i in order {
        out[i] = json!(0)
    }
    for id in order {
        for e in edges {
            let to = e.s("target");
            if e.s("source") == id && out.get(to).is_some() {
                out[to] = json!(out.n(to).max(out.n(id) + 1.))
            }
        }
    }
    out
}
pub fn loop_body(edges: &[Value], lp: &Value) -> Vec<String> {
    let reach = |start: &str, down: bool| {
        let mut seen = vec![start.to_string()];
        let mut at = 0;
        while at < seen.len() {
            let id = seen[at].clone();
            for e in edges.iter().filter(|e| e["loop"].is_null()) {
                let (from, to) = if down {
                    (e.s("source"), e.s("target"))
                } else {
                    (e.s("target"), e.s("source"))
                };
                if from == id && !seen.iter().any(|i| i == to) {
                    seen.push(to.into())
                }
            }
            at += 1;
        }
        seen
    };
    let after = reach(lp.s("target"), true);
    let before = reach(lp.s("source"), false);
    after.into_iter().filter(|id| before.contains(id)).collect()
}
pub fn skipped(flow: &[Value], decisions: &Value) -> Vec<String> {
    let edges: Vec<Value> = flow
        .iter()
        .flat_map(|s| {
            s.a("after")
                .iter()
                .map(|a| json!({"source":a["id"],"target":s["id"]}))
        })
        .collect();
    let order = strings(
        &topological(
            &flow.iter().map(|s| s.s("id").into()).collect::<Vec<_>>(),
            &edges,
        )["order"],
    );
    let mut skipped = vec![];
    for id in &order {
        let s = find(flow, id).unwrap();
        if s.a("after").is_empty() {
            continue;
        }
        let veto = s.a("after").iter().any(|a| {
            find(flow, a.s("id")).is_some_and(|p| {
                p.a("veto")
                    .iter()
                    .any(|o| has(&decisions[a.s("id")], o.text()))
            })
        });
        let live = |a: &Value| {
            !skipped.iter().any(|id| id == a.s("id"))
                && !(find(flow, a.s("id")).is_some_and(|p| !p["branch"].is_null())
                    && !decisions[a.s("id")].is_null()
                    && !a.s("output").is_empty()
                    && !has(&decisions[a.s("id")], a.s("output")))
        };
        let runs = if s.s("join") == "any" {
            s.a("after").iter().any(live)
        } else {
            s.a("after").iter().all(live)
        };
        if veto || !runs {
            skipped.push(id.clone())
        }
    }
    skipped
}
pub fn decision_error(
    flow: &[Value],
    decisions: &Value,
    node: &str,
    outputs: &[String],
) -> Option<String> {
    let Some(s) = find(flow, node).filter(|s| !s["branch"].is_null()) else {
        return Some(format!(
            "'{node}' 는 이 워크플로의 분기·게이트 단계가 아닙니다."
        ));
    };
    if outputs.is_empty() || unique(outputs.to_vec()).len() != outputs.len() {
        return Some("출력을 하나 이상, 중복 없이 고르세요.".into());
    }
    let all = strings(&s["branch"]["outputs"]);
    if let Some(bad) = outputs.iter().find(|o| !all.contains(o)) {
        return Some(format!(
            "'{bad}' 는 이 분기의 출력이 아닙니다. 출력: {}",
            all.join(", ")
        ));
    }
    if s["branch"].s("mode") == "exclusive" && outputs.len() != 1 {
        return Some("이 분기는 출력을 하나만 고를 수 있습니다.".into());
    }
    if skipped(flow, decisions).iter().any(|id| id == node) {
        return Some("이 분기는 이미 건너뛴 단계입니다.".into());
    }
    if decisions.get(node).is_some() {
        let prev = strings(&decisions[node]);
        if prev.len() != outputs.len() || prev.iter().any(|i| !outputs.contains(i)) {
            return Some(format!(
                "이 분기는 이미 {} 로 결정되었습니다.",
                prev.join(", ")
            ));
        }
    }
    None
}
pub fn execution_tasks(e: &Value, paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .filter_map(|path| {
            if !e["bindings"].s(path).is_empty() {
                return Some(e["bindings"].s(path).into());
            }
            path.split_once('.').and_then(|(a, b)| {
                e["links"][a]
                    .get(b)
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
        })
        .collect()
}
fn loop_result(e: &Value, lp: &Value, restart: &Value, count: f64) -> Value {
    let mut rounds = object();
    for id in restart.list() {
        rounds[id.text()] = json!(stage_round(e, id.text()))
    }
    json!({"edge":lp["edge"],"to":lp["to"],"restart":restart,"pass":rounds.get(lp.s("to")).cloned().unwrap_or(json!(stage_round(e,lp.s("to")))),"rounds":rounds,"max":lp["max"],"remaining":lp.n("max")-count})
}
pub fn apply_decision(flow: &[Value], e: &Value, node: &str, outputs: &[String]) -> Value {
    let lp = find(flow, node).and_then(|s| {
        s.a("loops")
            .iter()
            .find(|lp| outputs.iter().any(|o| o == lp.s("output")))
    });
    let decide = |chosen: &[String]| {
        let mut next = e.clone();
        if !next["decisions"].is_object() {
            next["decisions"] = object()
        }
        next["decisions"][node] = json!(chosen);
        next["skipped"] = json!(skipped(flow, &next["decisions"]));
        next
    };
    let Some(lp) = lp else {
        let mut out = json!({"execution":decide(outputs)});
        if !e["decisions"][node].is_null() {
            out["repeated"] = json!(true)
        }
        return out;
    };
    let edge = lp.s("edge");
    let count = e["loops"].n(edge);
    if let Some(last) = e.a("history").last() {
        if last.s("edge") == edge
            && e["bindings"].s(node).is_empty()
            && e["decisions"][node].is_null()
            && last["decisions"][node] == json!(outputs)
        {
            return json!({"execution":e,"loop":loop_result(e,lp,&last["nodes"],count),"repeated":true});
        }
    }
    if count >= lp.n("max") {
        return json!({"execution":decide(&[lp.s("exit").into()]),"exhausted":{"output":lp["exit"],"max":lp["max"]}});
    }
    let mut body = strings(&lp["body"]);
    let mut kept = e["decisions"].clone();
    if !kept.is_object() {
        kept = object()
    }
    for id in &body {
        drop_keys(&mut kept, &[id]);
    }
    let next_skipped = skipped(flow, &kept);
    for stage in flow {
        let id = stage.s("id");
        if !body.iter().any(|i| i == id)
            && has(&e["skipped"], id)
            && !next_skipped.iter().any(|i| i == id)
            && !e["bindings"].s(id).is_empty()
        {
            body.push(id.into())
        }
    }
    let restart: Vec<String> = flow
        .iter()
        .map(|s| s.s("id").to_string())
        .filter(|id| body.contains(id))
        .collect();
    let part = |v: &Value, inside: bool| {
        Value::Object(
            entries(v)
                .into_iter()
                .filter(|(id, _)| body.contains(id) == inside)
                .collect(),
        )
    };
    let mut pass = json!({"edge":edge,"pass":count+1.,"nodes":restart,"bindings":part(&e["bindings"],true),"decisions":part(&e["decisions"],true)});
    pass["decisions"][node] = json!(outputs);
    let spawned = part(&e["spawned"], true);
    if !entries(&spawned).is_empty() {
        pass["spawned"] = spawned
    }
    let mut next = e.clone();
    drop_keys(&mut next, &["spawned"]);
    let spawn_kept = part(&e["spawned"], false);
    if !entries(&spawn_kept).is_empty() {
        next["spawned"] = spawn_kept
    }
    next["bindings"] = part(&e["bindings"], false);
    next["decisions"] = part(&e["decisions"], false);
    next["skipped"] = json!(skipped(flow, &next["decisions"]));
    if !next["loops"].is_object() {
        next["loops"] = object()
    }
    next["loops"][edge] = json!(count + 1.);
    next["history"] = json!(
        e.a("history")
            .iter()
            .cloned()
            .chain([pass])
            .collect::<Vec<_>>()
    );
    let info = loop_result(&next, lp, &json!(restart), count + 1.);
    json!({"execution":next,"loop":info})
}
pub fn pending(flow: &[Value], e: &Value, s: &Value) -> Value {
    if s.is_null() {
        return json!([]);
    }
    let status = |id: &str| {
        let task = execution_tasks(e, &[id.into()]);
        binding_status(task.first().map(String::as_str).unwrap_or(""), s, false)
    };
    json!(flow.iter().filter(|stage|{let worker=!stage["veto"].is_null()&&stage.s("judge")=="previous";!stage["branch"].is_null()&&e["decisions"][stage.s("id")].is_null()&&!has(&e["skipped"],stage.s("id"))&&if stage.s("judge")=="user"{stage.a("after").iter().all(|a|has(&e["skipped"],a.s("id"))||status(a.s("id"))=="completed")}else{worker&&stage.a("after").len()==1&&status(stage["after"][0].s("id"))=="blocked"}}).map(|stage|{let id=stage.s("id");let mut out=json!({"executionId":e["id"],"executionLabel":e["label"],"node":id,"label":stage.get("label").unwrap_or(&stage["id"]),"question":stage.s("question"),"mode":stage["branch"]["mode"],"outputs":stage["branch"].a("outputs").iter().map(|id|json!({"id":id,"label":stage["outputLabels"].get(id.text()).unwrap_or(id)})).collect::<Vec<_>>()});if let Some(task)=execution_tasks(e,&[id.into()]).first(){out["taskId"]=json!(task)}if !stage["veto"].is_null()&&stage.s("judge")=="previous"{if let Some(asker)=find(flow,stage["after"][0].s("id")){let mut a=json!({"label":asker.get("label").unwrap_or(&asker["id"])});if let Some(task)=execution_tasks(e,&[asker.s("id").into()]).first(){a["taskId"]=json!(task)}out["askedBy"]=a}}out}).collect::<Vec<_>>())
}
pub fn variable_refs(text: &str) -> Vec<String> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}").unwrap());
    unique(re.captures_iter(text).map(|m| m[1].into()))
}
pub fn substitute(text: &str, values: &Value) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}").unwrap());
    re.replace_all(text, |m: &regex::Captures| {
        values
            .get(&m[1])
            .and_then(Value::as_str)
            .unwrap_or(&m[0])
            .to_string()
    })
    .to_string()
}
pub fn resolve_variables(vars: &Value, given: &Value) -> Value {
    let mut values = object();
    let mut missing = vec![];
    for v in vars.list() {
        let key = v.s("key");
        let value = if given.s(key).trim().is_empty() {
            v.s("default").trim()
        } else {
            given.s(key).trim()
        };
        if !value.is_empty() {
            values[key] = json!(value)
        } else if v.b("required") {
            missing.push(v.clone())
        }
    }
    json!({"values":values,"missing":missing})
}
pub fn user_decisions(flow: &[Value], e: &Value) -> Value {
    let mut latest = object();
    for pass in e.a("history").iter().chain([e]) {
        for (k, v) in entries(&pass["decisions"]) {
            latest[k] = v
        }
    }
    json!(flow.iter().filter(|s|!s["branch"].is_null()&&s.s("judge")=="user"&&s["veto"].is_null()&&!latest[s.s("id")].is_null()).map(|s|json!({"node":s["id"],"label":s.get("label").unwrap_or(&s["id"]),"outputs":latest[s.s("id")]})).collect::<Vec<_>>())
}
pub fn user_section(values: &Value) -> String {
    if values.list().is_empty() {
        return String::new();
    }
    format!(
        "## 앞 사용자 분기 판정\n{}\n",
        values
            .list()
            .iter()
            .map(|v| format!(
                "- {} ({}): {}",
                v.s("node"),
                v.s("label"),
                strings(&v["outputs"]).join(", ")
            ))
            .collect::<Vec<_>>()
            .join("\n")
    )
}
pub fn logged(executions: &[Value]) -> Value {
    json!(
        executions
            .iter()
            .map(|e| {
                let tasks = unique(
                    e.a("history")
                        .iter()
                        .flat_map(|p| entries(&p["bindings"]))
                        .chain(entries(&e["bindings"]))
                        .chain(
                            entries(&e["links"])
                                .iter()
                                .flat_map(|(_, v)| entries(v))
                                .collect::<Vec<_>>(),
                        )
                        .map(|(_, v)| v.text().into()),
                );
                let mut out = json!({"id":e["id"],"label":e["label"],"tasks":tasks});
                let skipped = execution_tasks(e, &strings(&e["skipped"]));
                if !skipped.is_empty() {
                    out["skipped"] = json!(skipped)
                }
                out
            })
            .collect::<Vec<_>>()
    )
}
pub fn results(executions: &[Value], s: &Value) -> Value {
    json!(executions.iter().map(|e|{let stages:Vec<Value>=e.a("tasks").iter().map(|id|{let task=find(s.a("tasks"),id.text());json!({"taskId":id,"title":task.and_then(|t|t.get("title")).unwrap_or(id),"status":if has(&e["skipped"],id.text()){"skipped"}else{task_status(task.unwrap_or(&Value::Null),s.a("workers"))}})}).collect();let statuses:Vec<Value>=stages.iter().map(|s|s["status"].clone()).collect();let done=finished(&statuses);json!({"id":e["id"],"label":e["label"],"status":aggregate(&statuses),"finished":done,"stages":stages.into_iter().map(|mut s|{if s.s("status")=="skipped"||(done&&s.s("status")=="pending"){s["skipped"]=json!(true)}s}).collect::<Vec<_>>()})}).collect::<Vec<_>>())
}
pub fn frame_contents(id: &str, nodes: &[Value], rects: &Value) -> Vec<String> {
    let r = &rects[id];
    if r.is_null() {
        return vec![];
    }
    let within = |x: f64, y: f64| {
        x >= r.n("x")
            && x <= r.n("x") + r.n("width")
            && y >= r.n("y")
            && y <= r.n("y") + r.n("height")
    };
    let inside: Vec<String> = nodes
        .iter()
        .filter(|n| {
            let p = &rects[n.s("id")];
            if n.s("id") == id || p.is_null() {
                return false;
            }
            if group(n) || frame(n) {
                within(p.n("x"), p.n("y"))
                    && within(p.n("x") + p.n("width"), p.n("y") + p.n("height"))
            } else {
                within(p.n("x") + p.n("width") / 2., p.n("y") + p.n("height") / 2.)
            }
        })
        .map(|n| n.s("id").into())
        .collect();
    nodes
        .iter()
        .filter(|n| {
            if !inside.iter().any(|id| id == n.s("id")) {
                return false;
            }
            let mut p = n.s("parentId");
            for _ in 0..=4 {
                if p.is_empty() {
                    break;
                }
                if inside.iter().any(|id| id == p) {
                    return false;
                }
                p = find(nodes, p).map(|n| n.s("parentId")).unwrap_or("");
            }
            true
        })
        .map(|n| n.s("id").into())
        .collect()
}
pub fn dispatch(op: &str, a: &Value) -> Result<Value, String> {
    Ok(match op {
        "taskStatus" => json!(task_status(&a[0], a[1].list())),
        "nodeExecutionStatus" => json!(node_status(
            &a[0],
            &a[1],
            &a[2],
            a[3].as_bool().unwrap_or(false)
        )),
        "aggregateStatus" => json!(aggregate(a[0].list())),
        "executionFinished" => json!(finished(a[0].list())),
        "executionStatuses" => json!(statuses(
            a[0].list(),
            &a[1],
            &a[2],
            a[3].as_bool().unwrap_or(false)
        )),
        "tallyStatuses" => tally(a[0].list()),
        "summarizeExecution" => summary(a[0].list(), &a[1], &a[2], a[3].as_bool().unwrap_or(false)),
        "projectNodes" => project_nodes(
            a[0].list(),
            &a[1],
            a[2].as_bool().unwrap_or(false),
            a[3].list(),
            a[4].text(),
            a.get(5).filter(|v| !v.is_null()),
        ),
        "topologicalOrder" => topological(&strings(&a[0]), a[1].list()),
        "waves" => waves(&strings(&a[0]), a[1].list()),
        "loopBody" => json!(loop_body(a[0].list(), &a[1])),
        "skippedStages" => json!(skipped(a[0].list(), &a[1])),
        "decisionError" => json!(decision_error(
            a[0].list(),
            &a[1],
            a[2].text(),
            &strings(&a[3])
        )),
        "applyDecision" => apply_decision(a[0].list(), &a[1], a[2].text(), &strings(&a[3])),
        "pendingDecisions" => pending(a[0].list(), &a[1], &a[2]),
        "executionTasks" => json!(execution_tasks(&a[0], &strings(&a[1]))),
        "executionResults" => results(a[0].list(), &a[1]),
        "loggedExecutions" => logged(a[0].list()),
        "userDecisions" => user_decisions(a[0].list(), &a[1]),
        "userDecisionsSection" => json!(user_section(&a[0])),
        "stageRound" => json!(stage_round(&a[0], a[1].text())),
        "orderNodes" => json!(order_nodes(a[0].list())),
        "membershipOf" => membership(&a[0], &a[1]),
        "worktreeRepo" => json!(worktree_repo(&a[0], &a[1])),
        "frameContents" => json!(frame_contents(a[0].text(), a[1].list(), &a[2])),
        "variableRefs" => json!(variable_refs(a[0].text())),
        "substituteVariables" => json!(substitute(a[0].text(), &a[1])),
        "resolveVariables" => resolve_variables(&a[0], &a[1]),
        "serializableWorkflow" => serializable(&a[0]),
        "fromSnapshot" => {
            let s = &a[0];
            let nodes:Vec<Value>=s.a("tasks").iter().map(|t|json!({"id":t["id"],"type":"stage","position":{"x":0,"y":0},"data":{"kind":"worker","label":if t.s("title").is_empty(){t.s("spec").chars().take(60).collect::<String>()}else{t.s("title").into()},"description":t["spec"],"taskId":t["id"]}})).collect();
            let edges:Vec<Value>=s.a("tasks").iter().flat_map(|t|t.a("deps").iter().filter(|dep|find(s.a("tasks"),dep.text()).is_some()).map(|dep|json!({"id":format!("{}-{}",dep.text(),t.s("id")),"source":dep,"target":t["id"]}))).collect();
            json!({"name":s["run"]["objective"],"runId":s["run"]["id"],"nodes":crate::layout::auto_layout(&nodes,&edges,&Value::Null),"edges":edges})
        }
        _ => return crate::workflow::dispatch(op, a),
    })
}

pub fn serializable(g: &Value) -> Value {
    let nodes = g.a("nodes");
    let node_ids: HashSet<&str> = nodes.iter().map(|n| n.s("id")).collect();
    let group_ids: HashSet<&str> = nodes
        .iter()
        .filter(|n| group(n))
        .map(|n| n.s("id"))
        .collect();
    let branch_ids: HashSet<&str> = nodes
        .iter()
        .filter(|n| branch(n))
        .map(|n| n.s("id"))
        .collect();
    let frames: HashSet<&str> = nodes
        .iter()
        .filter(|n| frame(n))
        .map(|n| n.s("id"))
        .collect();
    let mut out = g.clone();
    drop_keys(
        &mut out,
        &[
            "executions",
            "workspace",
            "cleanup",
            "automations",
            "variables",
            "coordinatorGroup",
            "tags",
        ],
    );
    for k in ["tags", "automations"] {
        if !g.a(k).is_empty() {
            out[k] = g[k].clone()
        }
    }
    if !g.s("workspace").is_empty() {
        out["workspace"] = g["workspace"].clone()
    }
    if group_ids.contains(g.s("coordinatorGroup")) {
        out["coordinatorGroup"] = g["coordinatorGroup"].clone()
    }
    if !g["cleanup"].is_null() {
        out["cleanup"] = json!({"coordinator":g["cleanup"].b("coordinator"),"worktrees":g["cleanup"].b("worktrees"),"sessions":g["cleanup"].b("sessions")})
    }
    if !g.a("variables").is_empty() {
        out["variables"]=json!(g.a("variables").iter().map(|v|{let mut p=json!({"key":v["key"],"label":if v.s("label").trim().is_empty(){v.s("key")}else{v.s("label").trim()}});for k in ["description","default"]{if truth(&v[k]){p[k]=v[k].clone()}}if v.b("required"){p["required"]=json!(true)}p}).collect::<Vec<_>>())
    }
    let executions: Vec<Value> = g
        .a("executions")
        .iter()
        .map(|e| {
            let bindings: serde_json::Map<String, Value> = entries(&e["bindings"])
                .into_iter()
                .filter(|(id, t)| node_ids.contains(id.as_str()) && truth(t))
                .collect();
            let mut p = json!({"id":e["id"],"label":e["label"],"bindings":bindings});
            let links: serde_json::Map<String, Value> = entries(&e["links"])
                .into_iter()
                .filter(|(id, t)| node_ids.contains(id.as_str()) && !entries(t).is_empty())
                .collect();
            if !links.is_empty() {
                p["links"] = json!(links)
            }
            for k in ["decisions", "inputs", "values", "loops"] {
                if !entries(&e[k]).is_empty() {
                    p[k] = e[k].clone()
                }
            }
            for k in ["skipped", "history"] {
                if !e.a(k).is_empty() {
                    p[k] = e[k].clone()
                }
            }
            if !e.s("runId").is_empty() {
                p["runId"] = e["runId"].clone()
            }
            if !e["automation"].is_null() {
                p["automation"] = json!({"id":e["automation"]["id"],"name":e["automation"]["name"]})
            }
            let spawned: serde_json::Map<String, Value> = entries(&e["spawned"])
                .into_iter()
                .filter(|(id, _)| node_ids.contains(id.as_str()))
                .collect();
            if !spawned.is_empty() {
                p["spawned"] = json!(spawned)
            }
            p
        })
        .collect();
    if !executions.is_empty() {
        out["executions"] = json!(executions)
    }
    out["nodes"]=json!(order_nodes(nodes).iter().map(|n|{let d=&n["data"];let kind=d.s("kind");let mut data=json!({"label":d["label"],"description":d["description"],"kind":kind});let mut pick=|keys:&[&str]|{for k in keys{if truth(&d[*k]){data[*k]=d[*k].clone()}}};if group(n){if create(n){let source=if d.s("nameSource").is_empty(){"fixed"}else{d.s("nameSource")};pick(&["baseBranch","perExecution"]);data["scope"]=json!("worktree");data["path"]=json!("");data["worktreeMode"]=json!("create");data["repoPath"]=json!(d.s("repoPath"));data["nameSource"]=json!(source);let key=match source{"agent"=>"nameFrom","input"=>"inputPrompt",_=>"worktreeName"};if truth(&d[key]){data[key]=d[key].clone()}if !d.s("parentPath").trim().is_empty(){data["parentPath"]=json!(d.s("parentPath").trim())}}else if d.s("scope")=="worktree"{pick(&["ref","repoPath","worktreeName","branch"]);data["scope"]=json!("worktree");data["path"]=json!(d.s("path"));}else{pick(&["ref"]);data["scope"]=json!(if d.s("scope").is_empty(){"project"}else{d.s("scope")});data["path"]=json!(d.s("path"));}}else if kind=="workflow"{pick(&["workflowId"]);if !d.s("linkMode").is_empty()&&d.s("linkMode")!="wait"{data["linkMode"]=d["linkMode"].clone()}if spawn(n)&&d.s("spawnAs")=="subcoordinator"{data["spawnAs"]=json!("subcoordinator")}}else if branch(n){pick(&["taskId"]);data["mode"]=json!(if d.s("mode").is_empty(){"exclusive"}else{d.s("mode")});data["judge"]=json!(if d.s("judge").is_empty(){"previous"}else{d.s("judge")});data["outputs"]=json!(d.a("outputs").iter().map(|o|json!({"id":o["id"],"label":o["label"]})).collect::<Vec<_>>())}else if kind=="script"{pick(&["taskId","detach","timeoutSec"]);data["command"]=json!(d.s("command"));if !d.s("parse").is_empty()&&d.s("parse")!="none"{data["parse"]=d["parse"].clone()}if d.s("parse")=="regex"&&!d.s("itemPattern").is_empty(){data["itemPattern"]=d["itemPattern"].clone()}}else{pick(&["taskId"])}
        if launches(n){if d["fanout"].is_null(){if !d.s("workerModel").is_empty(){data["workerModel"]=d["workerModel"].clone()}}else{let mut fan=json!({"models":d["fanout"]["models"]});if !d["fanout"].s("variable").is_empty(){fan["variable"]=d["fanout"]["variable"].clone()}data["fanout"]=fan}if !d.s("effort").is_empty(){data["effort"]=d["effort"].clone()}if !session(n).is_empty(){data["session"]=json!(session(n))}}if !group(n)&&executable(n)&&d.s("join")=="any"{data["join"]=json!("any")}if kind=="gate"&&["previous","auto"].contains(&d.s("asker")){data["asker"]=d["asker"].clone()}
        let mut p=json!({"id":n["id"],"type":if group(n){"group"}else if frame(n){"frame"}else{"stage"},"position":n["position"],"data":data});if group_ids.contains(n.s("parentId"))&&(!group(n)||d.s("scope")=="worktree"){p["parentId"]=n["parentId"].clone()}if group(n)||frame(n){p["width"]=json!((n.get("width").or(n["measured"].get("width")).and_then(Value::as_f64).unwrap_or(if frame(n){560.}else{640.})+0.5).floor());p["height"]=json!((n.get("height").or(n["measured"].get("height")).and_then(Value::as_f64).unwrap_or(if frame(n){320.}else{360.})+0.5).floor())}if kind=="note"&&truth(&n["width"])&&truth(&n["height"]){p["width"]=json!((n.n("width")+0.5).floor());p["height"]=json!((n.n("height")+0.5).floor())}p}).collect::<Vec<_>>());
    out["edges"] = json!(
        g.a("edges")
            .iter()
            .filter(|e| ![e.s("source"), e.s("target")]
                .iter()
                .any(|id| group_ids.contains(id) || frames.contains(id)))
            .map(|e| {
                let mut p = json!({"id":e["id"],"source":e["source"],"target":e["target"]});
                copy_keys(&mut p, e, &["label"]);
                if branch_ids.contains(e.s("source")) {
                    if !e.s("sourceHandle").is_empty() {
                        p["sourceHandle"] = e["sourceHandle"].clone()
                    }
                    if !e["loop"].is_null() {
                        p["loop"] = json!({"max":e["loop"]["max"],"exit":e["loop"]["exit"]})
                    }
                }
                p
            })
            .collect::<Vec<_>>()
    );
    out
}
