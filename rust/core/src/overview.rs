use crate::{JsonExt, drop_keys, model, object, workflow};
use serde_json::{Value, json};
pub fn overview_entries(graphs: &[Value], observations: &Value) -> Value {
    let mut entries = vec![];
    for g in graphs {
        for e in workflow::overview_executions(g) {
            let run = model::execution_run(g, &e);
            if run.is_empty() {
                continue;
            }
            let observation = &observations[run];
            let stages:Vec<Value>=g.a("nodes").iter().filter(|n|model::executable(n)).map(|n|json!({"node":n,"status":model::node_status(n,&e,&observation["snapshot"],!observation.s("error").is_empty()),"round":model::stage_round(&e,n.s("id"))})).collect();
            let statuses: Vec<Value> = stages.iter().map(|s| s["status"].clone()).collect();
            if stages.is_empty() || model::finished(&statuses) {
                continue;
            }
            let mut entry = json!({"workflow":g,"execution":e,"runId":run,"stages":stages,"status":model::aggregate(&statuses),"done":statuses.iter().filter(|s|["completed","skipped"].contains(&s.text())).count()});
            if !observation["snapshot"]["observedAt"].is_null() {
                entry["observedAt"] = observation["snapshot"]["observedAt"].clone()
            }
            if !observation["error"].is_null() {
                entry["error"] = observation["error"].clone()
            }
            entries.push(entry)
        }
    }
    json!(entries)
}
pub fn overview_workflows(items: &[Value]) -> Value {
    let mut groups: Vec<Vec<&Value>> = vec![];
    for item in items {
        if let Some(group) = groups
            .iter_mut()
            .find(|g| g[0]["workflow"].s("id") == item["workflow"].s("id"))
        {
            group.push(item)
        } else {
            groups.push(vec![item])
        }
    }
    json!(groups.iter().map(|items|{let g=&items[0]["workflow"];let stages:Vec<Value>=g.a("nodes").iter().filter(|n|model::executable(n)).map(|n|{let samples=items.iter().flat_map(|e|e.a("stages")).filter(|s|s["node"].s("id")==n.s("id")).collect::<Vec<_>>();let statuses=samples.iter().map(|s|s["status"].clone()).collect::<Vec<_>>();json!({"node":n,"status":model::aggregate(&statuses),"round":samples.iter().map(|s|s.n("round")as usize).max().unwrap_or(1).max(1),"tally":model::tally(&statuses)})}).collect();let tally=model::tally(&items.iter().flat_map(|i|i.a("stages").iter().map(|s|s["status"].clone())).collect::<Vec<_>>());let status=["failed","blocked","running","unknown","pending","unbound"].into_iter().find(|s|tally.list().iter().any(|t|t.s("status")==*s)).unwrap_or("completed");let mut decisions=object();for stage in &stages{let id=stage["node"].s("id");if items.iter().all(|i|!i["execution"]["decisions"][id].is_null()){decisions[id]=json!(model::unique(items.iter().flat_map(|i|i["execution"]["decisions"][id].list().iter().map(|v|v.text().to_owned()))))}}let errors=model::unique(items.iter().filter(|i|!i.s("error").is_empty()).map(|i|i.s("error").into()));let mut out=json!({"workflow":g,"executionCount":items.len(),"stages":stages,"status":status,"done":stages.iter().filter(|s|["completed","skipped"].contains(&s.s("status"))).count(),"tally":tally,"decisions":decisions});if let Some(at)=items.iter().filter(|i|!i.s("observedAt").is_empty()).map(|i|i.s("observedAt")).max(){out["observedAt"]=json!(at)}if !errors.is_empty(){out["error"]=json!(format!("일부 실행 상태 미확인 · {}",errors.join(" · ")))}out}).collect::<Vec<_>>())
}
pub fn without_unknown(entry: &Value) -> Value {
    let known = |t: &Value| {
        json!(
            t.list()
                .iter()
                .filter(|i| i.s("status") != "unknown")
                .cloned()
                .collect::<Vec<_>>()
        )
    };
    let mut out = entry.clone();
    drop_keys(&mut out, &["error"]);
    let tally = known(&entry["tally"]);
    if entry.s("status") == "unknown" {
        out["status"] = json!(
            ["failed", "blocked", "running", "pending", "unbound"]
                .into_iter()
                .find(|s| tally.list().iter().any(|t| t.s("status") == *s))
                .unwrap_or("pending")
        )
    }
    out["tally"] = tally;
    out["stages"] = json!(
        entry
            .a("stages")
            .iter()
            .map(|s| {
                let mut s = s.clone();
                s["tally"] = known(&s["tally"]);
                s
            })
            .collect::<Vec<_>>()
    );
    out
}
