use crate::{
    bridge::now,
    error::{Error, Result},
    store::{read_json, write_private},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use workflow_core::{JsonExt, entries, model, object, validate};
pub const QUIET_EVERY: i64 = 300_000;
pub const SETTLED_EVERY: i64 = 900_000;
pub fn millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn time(s: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}
fn last(events: &[Value], kind: &str) -> isize {
    events
        .iter()
        .rposition(|e| e.s("type") == kind)
        .map(|i| i as isize)
        .unwrap_or(-1)
}
pub fn ended(events: &[Value]) -> bool {
    let f = last(events, "finished");
    (f >= 0 && f > last(events, "task"))
        || last(events, "coordinator-lost") > f
        || events.iter().any(|e| e.s("type") == "coordinator-failed")
}
pub fn stamp(id: &str) -> Option<String> {
    if id.len() < 25 {
        return None;
    }
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-").unwrap()
    });
    let m = re.captures(id)?;
    Some(format!(
        "{}T{}:{}:{}.{}Z",
        &m[1], &m[2], &m[3], &m[4], &m[5]
    ))
}
pub fn launch_name(at: &str, id: &str) -> String {
    format!("{}-{id}", at.replace([':', '.'], "-"))
}
pub fn valid_launch(workflow: &str, id: &str) -> bool {
    validate::valid_id(workflow)
        && validate::matches(r"^[a-zA-Z0-9_-]{1,200}$", id)
        && id.ends_with(&format!("-{workflow}"))
        && stamp(id).is_some()
}
pub fn outcome(meta: &Value, events: &[Value]) -> String {
    if events.iter().any(|e| e.s("type") == "coordinator-failed") {
        return "failed".into();
    }
    let f = last(events, "finished");
    if f >= 0 && f > last(events, "task") {
        return if events[f as usize].s("status").is_empty() {
            "completed"
        } else {
            events[f as usize].s("status")
        }
        .into();
    }
    if last(events, "coordinator-lost") > f {
        return "stalled".into();
    }
    if meta.s("runId").is_empty() {
        return if meta.is_null() { "unknown" } else { "pending" }.into();
    }
    let mut latest = HashMap::new();
    for e in events {
        if e.s("type") == "execution" && !e.s("taskId").is_empty() && !e.s("status").is_empty() {
            latest.insert(e.s("taskId"), e.s("status"));
        }
    }
    if latest.values().any(|s| *s == "failed") {
        "failed"
    } else if latest.values().any(|s| *s == "blocked") {
        "blocked"
    } else {
        "running"
    }
    .into()
}
#[derive(Clone)]
pub struct RunLog {
    pub root: PathBuf,
    serial: Arc<Mutex<()>>,
    quiet_reads: Arc<Mutex<HashMap<String, i64>>>,
}
impl RunLog {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            serial: Arc::new(Mutex::new(())),
            quiet_reads: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    pub fn launches(&self, workflow: &str) -> Vec<String> {
        let mut out: Vec<String> = fs::read_dir(&self.root)
            .map(|r| {
                r.flatten()
                    .filter_map(|e| e.file_name().into_string().ok())
                    .filter(|name| {
                        stamp(name).is_some()
                            && (workflow.is_empty() || name.ends_with(&format!("-{workflow}")))
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.sort_by(|a, b| b.cmp(a));
        out
    }
    pub fn meta(&self, id: &str) -> Value {
        read_json(&self.root.join(id).join("meta.json")).unwrap_or(Value::Null)
    }
    pub fn events(&self, id: &str) -> Vec<Value> {
        fs::read_to_string(self.root.join(id).join("events.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }
    pub fn start(&self, id: &str, meta: &Value) -> Result<()> {
        write_private(
            &self.root.join(id).join("meta.json"),
            &serde_json::to_vec_pretty(meta)?,
        )
    }
    pub fn patch(&self, id: &str, patch: &Value) -> Result<()> {
        let _guard = self.serial.lock().unwrap();
        let mut meta = self.meta(id);
        if !meta.is_null() {
            for (k, v) in entries(patch) {
                meta[k] = v
            }
            self.start(id, &meta)?
        }
        Ok(())
    }
    pub fn append(&self, id: &str, event: &Value) -> Result<()> {
        let mut line = json!({"at":now()});
        for (k, v) in entries(event) {
            line[k] = v
        }
        let mut options = fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(self.root.join(id).join("events.jsonl"))?;
        let mut bytes = serde_json::to_vec(&line)?;
        bytes.push(b'\n');
        file.write_all(&bytes)?;
        Ok(())
    }
    pub fn owner(&self, run: &str) -> Option<String> {
        if run.is_empty() {
            return None;
        }
        self.launches("")
            .into_iter()
            .find(|id| self.meta(id).s("runId") == run)
    }
    pub fn append_run(&self, run: &str, event: &Value) -> Result<()> {
        if let Some(id) = self.owner(run) {
            self.append(&id, event)?
        }
        Ok(())
    }
    pub fn register(
        &self,
        workflow: &str,
        run: &str,
        executions: &Value,
        launch: &str,
    ) -> Result<Value> {
        let _guard = self.serial.lock().unwrap();
        let candidates = if !launch.is_empty() && valid_launch(workflow, launch) {
            vec![launch.to_owned()]
        } else {
            self.owner(run)
                .into_iter()
                .chain(self.launches(workflow))
                .collect()
        };
        for id in candidates {
            let mut meta = self.meta(&id);
            if meta.is_null() || (!meta.s("runId").is_empty() && meta.s("runId") != run) {
                continue;
            }
            let registered = meta.s("runId") == run;
            meta["runId"] = json!(run);
            meta["executions"] = executions.clone();
            self.start(&id, &meta)?;
            if !registered {
                self.append(&id,&json!({"type":"registered","message":format!("Run {run} 에 실행 {}개 등록",executions.list().len())}))?
            }
            return Ok(json!(id));
        }
        Ok(Value::Null)
    }
    pub fn adopt(&self, workflow: &str, name: &str, run: &str, executions: &Value) -> Result<()> {
        let _guard = self.serial.lock().unwrap();
        if run.is_empty() || self.owner(run).is_some() || executions.list().is_empty() {
            return Ok(());
        }
        for id in self.launches(workflow) {
            if !self.meta(&id).is_null() {
                continue;
            }
            self.start(&id,&json!({"workflowId":workflow,"workflowName":name,"startedAt":stamp(&id),"runId":run,"executions":executions,"adopted":true}))?;
            self.append(&id,&json!({"type":"adopted","message":format!("실행 로그 도입 전 실행을 Run {run} 에 연결. 이후 시각은 관찰한 시각이다.")}))?;
            break;
        }
        Ok(())
    }
    pub fn observe(&self, snapshot: &Value) -> Result<()> {
        let _guard = self.serial.lock().unwrap();
        let Some(id) = self.owner(snapshot["run"].s("id")) else {
            return Ok(());
        };
        let events = self.events(&id);
        let mut tasks = HashMap::new();
        let mut executions = HashMap::new();
        for e in &events {
            if !e.s("taskId").is_empty() && !e.s("status").is_empty() {
                if e.s("type") == "task" {
                    tasks.insert(e.s("taskId"), e.s("status"));
                } else if e.s("type") == "execution" {
                    executions.insert(e.s("taskId"), e.s("status"));
                }
            }
        }
        let at = snapshot.s("observedAt");
        for task in snapshot.a("tasks") {
            let status = model::task_status(task, snapshot.a("workers"));
            let from = tasks.get(task.s("id"));
            if from.copied() == Some(status) {
                continue;
            }
            let mut event = json!({"at":at,"type":"task","taskId":task["id"],"message":task["title"],"status":status});
            if let Some(from) = from {
                event["from"] = json!(from)
            }
            self.append(&id, &event)?;
        }
        let meta = self.meta(&id);
        if meta.a("executions").is_empty() {
            return Ok(());
        }
        let results = model::results(meta.a("executions"), snapshot);
        for result in results.list() {
            let status = if result.b("finished") {
                "completed"
            } else {
                result.s("status")
            };
            let notable = result.b("finished") || ["failed", "blocked"].contains(&status);
            let key = if notable { status } else { "open" };
            if executions.get(result.s("id")).copied().unwrap_or("open") == key || !notable {
                continue;
            }
            let stages = result
                .a("stages")
                .iter()
                .map(|s| {
                    format!(
                        "{} {}",
                        s.s("title"),
                        if s.b("skipped") {
                            "진행 안 함"
                        } else {
                            model::status_label(s.s("status"))
                        }
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            self.append(&id,&json!({"at":at,"type":"execution","taskId":result["id"],"status":status,"message":format!("{} {} — {stages}",result.s("label"),if result.b("finished"){"완료"}else{model::status_label(status)})}))?;
        }
        let settled = results
            .list()
            .iter()
            .all(|r| r.b("finished") || r.s("status") == "failed");
        let done = last(&events, "finished") > last(&events, "task");
        if settled && !done {
            let failed = results.list().iter().filter(|r| !r.b("finished")).count();
            let count = results.list().len();
            self.append(&id,&json!({"at":at,"type":"finished","status":if failed>0{"failed"}else{"completed"},"message":if failed>0{format!("실행 {count}개 중 {failed}개 실패")}else{format!("실행 {count}개 모두 완료")}}))?;
        }
        Ok(())
    }
    fn recent(id: &str) -> bool {
        stamp(id).is_some_and(|s| millis() - time(&s) < 7 * 24 * 60 * 60 * 1000)
    }
    fn quiet(&self, id: &str, events: &[Value], now: i64) -> bool {
        let at = events
            .last()
            .map(|e| time(e.s("at")))
            .unwrap_or_else(|| stamp(id).map(|s| time(&s)).unwrap_or(0));
        let mut tasks = HashMap::new();
        for e in events {
            if e.s("type") == "task" && !e.s("taskId").is_empty() {
                tasks.insert(e.s("taskId"), e.s("status"));
            }
        }
        let running = tasks.values().any(|s| *s == "running");
        now - at
            >= if running {
                6 * 60 * 60 * 1000
            } else {
                30 * 60 * 1000
            }
    }
    fn read_now(&self, reader: &str, id: &str, events: &[Value], now: i64) -> bool {
        let key = format!("{reader}:{id}");
        let mut reads = self.quiet_reads.lock().unwrap();
        if !self.quiet(id, events, now) {
            reads.remove(&key);
            return true;
        }
        if now - reads.get(&key).copied().unwrap_or(0) < QUIET_EVERY {
            return false;
        }
        reads.insert(key, now);
        true
    }
    pub fn watch_targets(&self) -> Vec<String> {
        self.launches("")
            .into_iter()
            .filter(|id| Self::recent(id) && !self.meta(id).s("runId").is_empty())
            .filter(|id| {
                let events = self.events(id);
                !ended(&events) && self.read_now("watch", id, &events, millis())
            })
            .map(|id| self.meta(&id).s("runId").into())
            .collect()
    }
    pub fn pace(&self, run: &str, now: i64) -> &'static str {
        let Some(id) = self.owner(run) else {
            return "moving";
        };
        let events = self.events(&id);
        if ended(&events) {
            "ended"
        } else if self.quiet(&id, &events, now) {
            "quiet"
        } else {
            "moving"
        }
    }
    pub fn coordinators_close(&self, now: i64, grace: i64) -> Value {
        json!(
            self.launches("")
                .iter()
                .filter_map(|id| {
                    if !Self::recent(id) {
                        return None;
                    }
                    let meta = self.meta(id);
                    if !meta.b("closeCoordinator")
                        || meta.s("coordinatorTerminal").is_empty()
                        || meta.b("subcoordinators")
                    {
                        return None;
                    }
                    let events = self.events(id);
                    let f = last(&events, "finished");
                    if f < 0
                        || last(&events, "coordinator-closed") >= 0
                        || last(&events, "task") > f
                    {
                        return None;
                    }
                    let report = events[f as usize..]
                        .iter()
                        .find(|e| e.s("type") == "report");
                    let due = report
                        .map(|e| now - time(e.s("at")) >= 60000)
                        .unwrap_or_else(|| now - time(events[f as usize].s("at")) >= grace);
                    due.then(|| json!({"id":id,"terminal":meta["coordinatorTerminal"]}))
                })
                .collect::<Vec<_>>()
        )
    }
    pub fn coordinators_watch(&self, now: i64) -> Value {
        json!(
            self.launches("")
                .iter()
                .filter_map(|id| {
                    let meta = self.meta(id);
                    if !Self::recent(id) || meta.s("coordinatorTerminal").is_empty() {
                        return None;
                    }
                    let events = self.events(id);
                    if ended(&events) || !self.read_now("coordinator", id, &events, now) {
                        return None;
                    }
                    let mut out = json!({"id":id,"terminal":meta["coordinatorTerminal"]});
                    if !meta.s("runId").is_empty() {
                        out["runId"] = meta["runId"].clone()
                    }
                    Some(out)
                })
                .collect::<Vec<_>>()
        )
    }
    pub fn mark_lost(&self, id: &str, terminal: &str) -> Result<bool> {
        let _guard = self.serial.lock().unwrap();
        let events = self.events(id);
        let f = last(&events, "finished");
        if (f >= 0 && f > last(&events, "task")) || last(&events, "coordinator-lost") > f {
            return Ok(false);
        }
        self.append(id,&json!({"type":"coordinator-lost","message":format!("코디네이터 터미널이 Orca 에서 사라졌는데 실행이 끝나지 않음 — 중단됨(stalled) · {terminal}")}))?;
        Ok(true)
    }
    pub fn live(&self) -> Value {
        let mut live = object();
        for id in self.launches("") {
            let meta = self.meta(&id);
            if !Self::recent(&id) || meta.s("runId").is_empty() || meta.s("workflowId").is_empty() {
                continue;
            }
            let events = self.events(&id);
            if ended(&events) {
                continue;
            }
            let mut tasks = HashMap::new();
            for e in &events {
                if e.s("type") == "task" && !e.s("taskId").is_empty() {
                    tasks.insert(e.s("taskId"), e.s("status"));
                }
            }
            let key = meta.s("workflowId");
            if live[key].is_null() {
                live[key] = json!({"running":0,"blocked":0})
            }
            for status in ["running", "blocked"] {
                live[key][status] = json!(
                    live[key].n(status) + tasks.values().filter(|s| **s == status).count() as f64
                )
            }
        }
        live
    }
    pub fn overview(&self, runs: &[String]) -> Value {
        let mut observations = object();
        let mut settled = vec![];
        for run in model::unique(runs.to_vec()) {
            let Some(id) = self.owner(&run) else { continue };
            let events = self.events(&id);
            let mut tasks = object();
            for event in &events {
                if event.s("type") == "task"
                    && !event.s("taskId").is_empty()
                    && !event.s("status").is_empty()
                {
                    tasks[event.s("taskId")] = event.clone()
                }
            }
            let f = last(&events, "finished");
            let lost = last(&events, "coordinator-lost") > f;
            if f > last(&events, "task") || lost {
                settled.push(run.clone())
            }
            let at = events
                .iter()
                .rev()
                .find(|e| ["task", "finished"].contains(&e.s("type")))
                .map(|e| e.s("at").to_string())
                .unwrap_or_else(|| stamp(&id).unwrap_or_default());
            let mut observation = json!({"snapshot":{"run":{"id":run,"objective":run,"updatedAt":""},"tasks":entries(&tasks).into_iter().map(|(id,e)|json!({"id":id,"title":e["message"],"spec":"","deps":[],"status":e["status"]})).collect::<Vec<_>>(),"workers":[],"observedAt":at}});
            if lost {
                observation["error"] = json!("코디네이터가 종료되어 실행이 중단되었습니다.")
            }
            observations[run] = observation
        }
        json!({"observations":observations,"settled":settled})
    }
    pub fn files(&self, id: &str) -> Vec<String> {
        let mut files: Vec<String> = fs::read_dir(self.root.join(id))
            .map(|r| {
                r.flatten()
                    .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
                    .filter_map(|e| e.file_name().into_string().ok())
                    .filter(|name| valid_file(name))
                    .collect()
            })
            .unwrap_or_default();
        files.sort();
        files
    }
    pub fn detail(&self, workflow: &str, id: &str) -> Result<Value> {
        if !valid_launch(workflow, id) {
            return Err(Error::new(400, "올바르지 않은 실행 로그 ID입니다."));
        }
        fs::metadata(self.root.join(id))?;
        let mut meta = json!({"workflowId":workflow,"workflowName":"","startedAt":stamp(id)});
        for (k, v) in entries(&self.meta(id)) {
            meta[k] = v
        }
        let events = self.events(id);
        Ok(
            json!({"meta":meta,"id":id,"events":events,"files":self.files(id),"outcome":outcome(&self.meta(id),&events)}),
        )
    }
    pub fn list(&self, workflow: &str) -> Result<Value> {
        let mut out = vec![];
        for id in self.launches(workflow).into_iter().take(50) {
            let detail = self.detail(workflow, &id)?;
            let mut item = detail["meta"].clone();
            item["id"] = json!(id);
            item["events"] = json!(detail.a("events").len());
            if let Some(last) = detail.a("events").last() {
                item["last"] = last.clone()
            }
            item["files"] = detail["files"].clone();
            item["outcome"] = detail["outcome"].clone();
            out.push(item)
        }
        Ok(json!(out))
    }
    pub fn file(&self, workflow: &str, id: &str, name: &str) -> Result<Value> {
        if !valid_launch(workflow, id) || !valid_file(name) {
            return Err(Error::new(400, "올바르지 않은 파일입니다."));
        }
        let path = self.root.join(id).join(name);
        let info = fs::metadata(&path)?;
        if !info.is_file() {
            return Err(Error::new(400, "올바르지 않은 파일입니다."));
        }
        let mut f = fs::File::open(path)?.take(1024 * 1024);
        let mut bytes = vec![];
        f.read_to_end(&mut bytes)?;
        Ok(
            json!({"name":name,"size":info.len(),"truncated":info.len()>1024*1024,"text":String::from_utf8_lossy(&bytes)}),
        )
    }
}
fn valid_file(name: &str) -> bool {
    !["meta.json", "events.jsonl"].contains(&name)
        && validate::matches(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}$", name)
}
