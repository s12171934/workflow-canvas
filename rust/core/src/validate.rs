use crate::{JsonExt, entries, model};
use serde_json::{Value, json};
use std::collections::HashSet;
pub fn matches(pattern: &str, s: &str) -> bool {
    static PATTERNS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, regex::Regex>>,
    > = std::sync::OnceLock::new();
    let mut patterns = PATTERNS.get_or_init(Default::default).lock().unwrap();
    patterns
        .entry(pattern.to_owned())
        .or_insert_with(|| regex::Regex::new(pattern).unwrap())
        .is_match(s)
}
pub fn valid_id(s: &str) -> bool {
    matches(r"^[a-zA-Z0-9_-]{1,128}$", s)
}
pub fn valid_name(s: &str) -> bool {
    !s.starts_with('-') && !s.contains("..") && matches(r"^[A-Za-z0-9._-]{1,80}$", s)
}
pub fn valid_model(s: &str) -> bool {
    matches(r"^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$", s)
}
pub fn length(s: &str) -> usize {
    s.encode_utf16().count()
}
fn string(v: &Value, max: usize) -> bool {
    v.as_str().is_some_and(|s| length(s) <= max)
}
pub fn control(s: &str) -> bool {
    s.chars().any(|c| c <= '\u{1f}')
}
pub fn valid_path(v: &Value, empty: bool) -> bool {
    v.as_str().is_some_and(|s| {
        length(s) <= 1024
            && if s.is_empty() {
                empty
            } else {
                s.starts_with('/')
            }
            && !control(s)
    })
}
pub fn valid_value(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| length(s) <= 2000 && !control(s) && !s.contains('\u{7f}'))
}
pub fn valid_trigger(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        ["hourly", "daily", "weekdays", "weekly"].contains(&s)
            || (s.trim().split_whitespace().count() == 5
                && matches(r"^[0-9*/,\- ]{9,100}$", s.trim()))
    })
}
fn optional(v: &Value, key: &str, p: impl FnOnce(&Value) -> bool) -> bool {
    v.get(key).is_none_or(p)
}
fn choice(v: &Value, key: &str, items: &[&str]) -> bool {
    optional(v, key, |v| v.as_str().is_some_and(|s| items.contains(&s)))
}
fn integer(v: &Value, min: f64, max: f64) -> bool {
    v.as_f64()
        .is_some_and(|n| n.fract() == 0. && n >= min && n <= max)
}
fn cleanup(v: &Value) -> bool {
    v.is_object()
        && ["coordinator", "worktrees", "sessions"]
            .iter()
            .all(|k| v[*k].is_boolean())
}
fn inputs(v: &Value) -> bool {
    v.is_object()
        && entries(v).iter().all(|(key, n)| {
            valid_id(key) && n.as_str().is_some_and(|s| s.is_empty() || valid_name(s))
        })
}
fn path_key(s: &str) -> bool {
    matches(r"^[a-zA-Z0-9_.-]{1,400}$", s)
}
fn key(s: &str) -> bool {
    matches(r"^[a-z][a-z0-9_]{0,39}$", s)
}
fn branch_name(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        !s.starts_with('-') && !s.contains("..") && matches(r"^[A-Za-z0-9._/-]{0,200}$", s)
    })
}
fn spawned(v: &Value, ids: &HashSet<&str>) -> bool {
    v.is_object()
        && entries(v).iter().all(|(id, rs)| {
            ids.contains(id.as_str())
                && rs.as_array().is_some_and(|rs| {
                    rs.len() <= 200
                        && rs.iter().all(|r| {
                            valid_name(r.s("item"))
                                && string(&r["at"], 40)
                                && valid_id(r.s("workflowId"))
                                && optional(r, "launch", |v| {
                                    v.as_str()
                                        .is_some_and(|s| matches(r"^[a-zA-Z0-9_-]{1,200}$", s))
                                })
                                && optional(r, "error", |v| string(v, 500))
                                && optional(r, "brief", |v| valid_path(v, false))
                                && optional(r, "worktree", |v| valid_path(v, false))
                        })
                })
        })
}
pub fn validate(value: &Value) -> Result<Value, String> {
    if !value.is_object() {
        return Err("워크플로 JSON 객체가 필요합니다.".into());
    }
    let mut g = value.clone();
    if g["version"] != json!(1)
        || !valid_id(g.s("id"))
        || !string(&g["name"], 500)
        || g.s("name").trim().is_empty()
        || !string(&g["description"], 10000)
        || !g["runId"].is_string()
        || (!g.s("runId").is_empty() && !valid_id(g.s("runId")))
        || !g["nodes"].is_array()
        || !g["edges"].is_array()
        || g.a("nodes").len() > 500
        || g.a("edges").len() > 2000
    {
        return Err("워크플로 형식 또는 크기가 올바르지 않습니다.".into());
    }
    if !optional(&g, "tags", |v| {
        let tags = v.list();
        v.is_array()
            && tags.len() <= 10
            && tags.iter().all(|t| {
                t.as_str().is_some_and(|s| {
                    !s.is_empty()
                        && length(s) <= 30
                        && s.trim() == s
                        && !control(s)
                        && !s.contains("  ")
                })
            })
            && model::unique(tags.iter().map(|v| v.text().into())).len() == tags.len()
    }) {
        return Err("태그는 10개까지, 겹치지 않게 30자 이하로 적으세요.".into());
    }
    for n in g["nodes"].as_array_mut().unwrap() {
        if n["data"].s("kind") == "task" {
            n["data"]["kind"] = json!("worker")
        }
    }
    let nodes = g.a("nodes");
    let mut ids = HashSet::new();
    let mut groups = HashSet::new();
    for n in nodes {
        let d = &n["data"];
        let group = model::group(n);
        let frame = model::frame(n);
        let expected = if group {
            "group"
        } else if frame {
            "frame"
        } else {
            "stage"
        };
        if !valid_id(n.s("id"))
            || !ids.insert(n.s("id"))
            || n.s("type") != expected
            || !n["position"]["x"].is_number()
            || !n["position"]["y"].is_number()
            || !string(&d["label"], 500)
            || !string(&d["description"], 20000)
            || ![
                "worker", "gate", "branch", "script", "note", "workflow", "group", "frame",
            ]
            .contains(&d.s("kind"))
            || !optional(d, "workerModel", |v| v.as_str().is_some_and(valid_model))
            || !choice(d, "effort", &["low", "medium", "high", "xhigh", "max"])
            || !optional(d, "session", |v| {
                d.s("kind") == "worker"
                    && d.get("fanout").is_none()
                    && v.as_str()
                        .is_some_and(|s| matches(r"^[a-z][a-z0-9-]{0,31}$", s))
            })
            || !optional(d, "linkMode", |v| {
                d.s("kind") == "workflow" && ["wait", "start", "spawn"].contains(&v.text())
            })
            || !optional(d, "spawnAs", |v| {
                d.s("kind") == "workflow" && ["coordinator", "subcoordinator"].contains(&v.text())
            })
            || !optional(d, "asker", |v| {
                d.s("kind") == "gate" && ["coordinator", "previous", "auto"].contains(&v.text())
            })
            || ["taskId", "workflowId"].iter().any(|k| {
                !optional(d, k, |v| {
                    v.as_str().is_some_and(|s| s.is_empty() || valid_id(s))
                })
            })
        {
            return Err("노드 ID·위치·속성이 올바르지 않습니다.".into());
        }
        let size_ok = ["width", "height"]
            .iter()
            .all(|k| optional(n, k, |v| v.as_f64().is_some_and(|x| x > 0. && x < 20000.)));
        if group
            && (!["project", "worktree"].contains(&d.s("scope"))
                || !valid_path(d.get("path").unwrap_or(&json!("")), true)
                || !optional(d, "ref", |v| string(v, 512) && !control(v.text()))
                || !optional(d, "worktreeMode", |v| {
                    d.s("scope") == "worktree" && ["existing", "create"].contains(&v.text())
                })
                || !optional(d, "repoPath", |v| valid_path(v, true))
                || !optional(d, "baseBranch", branch_name)
                || !optional(d, "branch", branch_name)
                || !optional(d, "worktreeName", |v| {
                    v.as_str().is_some_and(|s| s.is_empty() || valid_name(s))
                })
                || !choice(d, "nameSource", &["fixed", "agent", "input"])
                || !optional(d, "nameFrom", |v| v.as_str().is_some_and(valid_id))
                || !optional(d, "inputPrompt", |v| string(v, 500))
                || !optional(d, "perExecution", Value::is_boolean)
                || !optional(d, "parentPath", |v| {
                    string(v, 1024)
                        && !control(v.text())
                        && (v.text().trim().is_empty()
                            || ((v.text().trim_start().starts_with('/')
                                || v.text().trim_start().starts_with("{{"))
                                && d.s("worktreeMode") == "create"))
                })
                || !size_ok)
        {
            return Err("그룹 노드의 대상(프로젝트·워크트리)과 경로가 올바르지 않습니다.".into());
        }
        if frame && !size_ok {
            return Err("메모 그룹의 크기가 올바르지 않습니다.".into());
        }
        if !choice(d, "join", &["all", "any"]) {
            return Err("합류 방식은 all 또는 any 여야 합니다.".into());
        }
        let script_fields = ["command", "parse", "itemPattern", "detach", "timeoutSec"];
        let script_bad = if d.s("kind") != "script" {
            script_fields.iter().any(|k| d.get(k).is_some())
        } else {
            !optional(d, "command", |v| {
                string(v, 20000) && !v.text().contains('\0')
            }) || !choice(d, "parse", &["none", "jsonl", "regex"])
                || !optional(d, "itemPattern", |v| {
                    string(v, 500)
                        && d.s("parse") == "regex"
                        && regress::Regex::new(v.text()).is_ok()
                })
                || !optional(d, "detach", Value::is_boolean)
                || !optional(d, "timeoutSec", |v| integer(v, 1., 86400.))
        };
        if script_bad {
            return Err(
                "스크립트 드라이버 노드의 명령·출력 해석·정규식·제한 시간이 올바르지 않습니다."
                    .into(),
            );
        }
        if model::branch(n)
            && (!choice(d, "mode", &["exclusive", "inclusive"])
                || !choice(d, "judge", &["previous", "worker", "user"])
                || !optional(d, "outputs", |v| {
                    let mut seen = HashSet::new();
                    v.is_array()
                        && v.list().len() <= 8
                        && v.list().iter().all(|o| {
                            valid_id(o.s("id"))
                                && seen.insert(o.s("id"))
                                && string(&o["label"], 200)
                        })
                }))
        {
            return Err("분기 노드의 방식·판정 주체·출력(최대 8개)이 올바르지 않습니다.".into());
        }
        if group {
            groups.insert(n.s("id"));
        }
    }
    if !optional(&g, "coordinatorGroup", |v| {
        nodes.iter().any(|n| {
            n.s("id") == v.text()
                && model::group(n)
                && ["worktree", "project"].contains(&n["data"].s("scope"))
        })
    }) {
        return Err(
            "코디네이터 위치는 이 워크플로의 프로젝트 그룹이나 워크트리 그룹이어야 합니다.".into(),
        );
    }
    if nodes.iter().any(|n| {
        model::group(n)
            && !n["data"].s("nameFrom").is_empty()
            && !nodes.iter().any(|i| {
                i.s("id") == n["data"].s("nameFrom")
                    && ["worker", "gate", "workflow"].contains(&i["data"].s("kind"))
            })
    }) {
        return Err("워크트리 이름을 정할 단계가 이 워크플로에 없습니다.".into());
    }
    for n in nodes {
        if n.get("parentId").is_none() {
            continue;
        }
        if !groups.contains(n.s("parentId")) {
            return Err("노드는 그룹 노드 안에만 넣을 수 있습니다.".into());
        }
        if model::group(n) && n["data"].s("scope") != "worktree" {
            return Err("프로젝트 그룹은 다른 그룹 안에 넣을 수 없습니다.".into());
        }
        let mut p = n.s("parentId");
        let mut depth = 0;
        while !p.is_empty() {
            depth += 1;
            if p == n.s("id") || depth > 4 {
                return Err("그룹은 4단계까지 중첩할 수 있고 순환할 수 없습니다.".into());
            }
            p = model::find(nodes, p).map(|n| n.s("parentId")).unwrap_or("");
        }
    }
    let mut edge_ids = HashSet::new();
    for e in g.a("edges") {
        if !valid_id(e.s("id"))
            || !edge_ids.insert(e.s("id"))
            || !ids.contains(e.s("source"))
            || !ids.contains(e.s("target"))
            || !optional(e, "label", |v| string(v, 500))
        {
            return Err("연결의 ID 또는 대상 노드가 올바르지 않습니다.".into());
        }
        let source = model::find(nodes, e.s("source")).unwrap();
        if model::branch(source)
            && !source["data"]
                .a("outputs")
                .iter()
                .any(|o| o.s("id") == e.s("sourceHandle"))
        {
            return Err(format!(
                "'{}' 에서 나가는 연결은 분기의 출력에서 시작해야 합니다.",
                if source["data"].s("label").is_empty() {
                    "분기"
                } else {
                    source["data"].s("label")
                }
            ));
        }
    }
    let name = |id: &str| {
        model::find(nodes, id)
            .map(|n| n["data"].s("label"))
            .filter(|s| !s.is_empty())
            .unwrap_or(id)
            .to_string()
    };
    let forward: Vec<Value> = g
        .a("edges")
        .iter()
        .filter(|e| e.get("loop").is_none())
        .cloned()
        .collect();
    let topo = model::topological(
        &nodes.iter().map(|n| n.s("id").into()).collect::<Vec<_>>(),
        &forward,
    );
    if !topo["cycle"].is_null() {
        return Err(format!(
            "연결이 순환합니다: {}. 반복하려면 분기의 출력에서 앞 단계로 「되돌아가기」 연결을 쓰세요.",
            topo.a("cycle")
                .iter()
                .map(|v| name(v.text()))
                .collect::<Vec<_>>()
                .join(" → ")
        ));
    }
    for e in g.a("edges").iter().filter(|e| e.get("loop").is_some()) {
        let source = model::find(nodes, e.s("source")).unwrap();
        let lp = &e["loop"];
        let where_ = format!(
            "'{}' → '{}' 되돌아가기 연결",
            name(e.s("source")),
            name(e.s("target"))
        );
        if !lp.is_object() || !integer(&lp["max"], 1., 200.) || !lp["exit"].is_string() {
            return Err(format!(
                "{where_}에는 최대 반복 횟수(1~200)와 초과 시 출력이 필요합니다."
            ));
        }
        if !model::branch(source)
            || (!source["data"].s("mode").is_empty() && source["data"].s("mode") != "exclusive")
            || e.s("sourceHandle").is_empty()
        {
            return Err(format!(
                "{where_}은 「하나만」 고르는 분기의 출력에서 시작해야 합니다."
            ));
        }
        if lp.s("exit") == e.s("sourceHandle")
            || !source["data"]
                .a("outputs")
                .iter()
                .any(|o| o.s("id") == lp.s("exit"))
        {
            return Err(format!(
                "{where_}의 초과 시 출력은 같은 분기의 다른 출력이어야 합니다."
            ));
        }
        if g.a("edges").iter().any(|o| {
            o.s("id") != e.s("id")
                && o.s("source") == e.s("source")
                && o.s("sourceHandle") == e.s("sourceHandle")
        }) {
            return Err(format!(
                "{where_}이 나가는 출력에는 다른 연결을 둘 수 없습니다."
            ));
        }
        let body = model::loop_body(g.a("edges"), e);
        if !body.iter().any(|id| id == e.s("source")) {
            return Err(format!(
                "{where_}은 분기보다 앞에 있는(분기로 이어지는) 단계로만 돌아갈 수 있습니다."
            ));
        }
        if let Some(link) = body
            .iter()
            .filter_map(|id| model::find(nodes, id))
            .find(|n| n["data"].s("kind") == "workflow" && !model::spawn(n))
        {
            return Err(format!(
                "{where_}이 반복하는 구간에 워크플로 링크 '{}' 를 둘 수 없습니다. 「항목마다 따로 실행」 링크만 둘 수 있습니다.",
                name(link.s("id"))
            ));
        }
    }
    if !optional(&g, "cleanup", cleanup) {
        return Err("완료 시 정리 설정이 올바르지 않습니다.".into());
    }
    if !optional(&g, "variables", |v| {
        let mut seen = HashSet::new();
        v.is_array()
            && v.list().len() <= 30
            && v.list().iter().all(|v| {
                key(v.s("key"))
                    && seen.insert(v.s("key"))
                    && string(&v["label"], 100)
                    && !v.s("label").trim().is_empty()
                    && optional(v, "description", |v| string(v, 500))
                    && optional(v, "default", valid_value)
                    && optional(v, "required", Value::is_boolean)
            })
    }) {
        return Err("설정값은 30개까지, 키는 영문 소문자로 시작하는 소문자·숫자·_ 40자 이하로 겹치지 않게, 이름은 100자 이하로 적으세요.".into());
    }
    let declared: HashSet<&str> = g.a("variables").iter().map(|v| v.s("key")).collect();
    for n in nodes {
        let d = &n["data"];
        let Some(fan) = d.get("fanout") else { continue };
        let label = if d.s("label").is_empty() {
            n.s("id")
        } else {
            d.s("label")
        };
        let where_ = format!("'{label}' 의 모델별 병렬 워커");
        if d.s("kind") != "worker"
            || !fan.is_object()
            || !fan["models"].is_array()
            || fan
                .a("models")
                .iter()
                .any(|v| !v.as_str().is_some_and(valid_model))
            || !optional(fan, "variable", |v| {
                v.is_string() && declared.contains(v.text())
            })
        {
            return Err(format!(
                "{where_}는 워커 노드에만 두고, 모델 id 목록과 선언된 설정값 키로 적으세요."
            ));
        }
        if fan.a("models").is_empty() && fan.s("variable").is_empty() {
            return Err(format!(
                "{where_}에는 모델이 1개 이상 있거나 모델 목록 설정값이 연결돼야 합니다."
            ));
        }
        if d.get("workerModel").is_some() {
            return Err(format!(
                "{where_}에는 단일 모델(workerModel)을 함께 둘 수 없습니다."
            ));
        }
        if let Some(judged) = forward
            .iter()
            .filter(|e| e.s("source") == n.s("id"))
            .filter_map(|e| model::find(nodes, e.s("target")))
            .find(|t| {
                (model::branch(t)
                    && (t["data"].s("judge").is_empty() || t["data"].s("judge") == "previous"))
                    || (t["data"].s("kind") == "gate" && t["data"].s("asker") == "previous")
                    || model::spawn(t)
            })
        {
            return Err(format!(
                "{where_}는 판정·항목을 하나로 보고하지 않으므로 '{}' 의 판정 주체나 항목 보고 단계가 될 수 없습니다.",
                if judged["data"].s("label").is_empty() {
                    judged.s("id")
                } else {
                    judged["data"].s("label")
                }
            ));
        }
    }
    if !optional(&g, "automations", |v| {
        let mut seen = HashSet::new();
        v.is_array()
            && v.list().len() <= 20
            && v.list().iter().all(|a| {
                valid_id(a.s("id"))
                    && seen.insert(a.s("id"))
                    && optional(a, "orcaId", |v| {
                        v.as_str()
                            .is_some_and(|s| matches(r"^[a-zA-Z0-9-]{1,128}$", s))
                    })
                    && string(&a["name"], 100)
                    && !a.s("name").trim().is_empty()
                    && !control(a.s("name"))
                    && valid_trigger(&a["trigger"])
                    && optional(a, "time", |v| {
                        v.is_string() && matches(r"^([01]\d|2[0-3]):[0-5]\d$", v.text())
                    })
                    && optional(a, "day", |v| integer(v, 0., 6.))
                    && valid_path(&a["project"], false)
                    && integer(&a["count"], 1., 20.)
                    && cleanup(&a["cleanup"])
                    && optional(a, "inputs", inputs)
                    && optional(a, "values", |v| {
                        v.is_object()
                            && entries(v)
                                .iter()
                                .all(|(k, v)| declared.contains(k.as_str()) && valid_value(v))
                    })
            })
    }) {
        return Err("자동화 설정이 올바르지 않습니다.".into());
    }
    if !optional(&g, "workspace", |v| valid_path(v, true)) {
        return Err("작업 위치는 절대 경로여야 합니다.".into());
    }
    if let Some(executions) = g.get("executions") {
        if !executions.is_array() || executions.list().len() > 100 {
            return Err("실행 목록 형식 또는 크기가 올바르지 않습니다.".into());
        }
        let mut seen = HashSet::new();
        for e in executions.list() {
            let bindings = |v: &Value, known: bool| {
                v.is_object()&&entries(v).iter().all(|(id,t)|if known{ids.contains(id.as_str())}else{valid_id(id)}&&t.as_str().is_some_and(valid_id))
            };
            let decisions = |v: &Value, min: usize| {
                v.is_object()
                    && entries(v).len() <= 500
                    && entries(v).iter().all(|(path, o)| {
                        path_key(path)
                            && o.is_array()
                            && o.list().len() >= min
                            && o.list().len() <= 8
                            && o.list().iter().all(|v| v.as_str().is_some_and(valid_id))
                    })
            };
            let history = |v: &Value| {
                v.is_array()
                    && v.list().len() <= 1000
                    && v.list().iter().all(|p| {
                        valid_id(p.s("edge"))
                            && p["pass"].as_f64().is_some_and(|v| v.fract() == 0.)
                            && p["nodes"].is_array()
                            && p.a("nodes")
                                .iter()
                                .all(|v| v.as_str().is_some_and(valid_id))
                            && bindings(&p["bindings"], false)
                            && optional(p, "decisions", |v| decisions(v, 0))
                            && optional(p, "spawned", |v| spawned(v, &ids))
                    })
            };
            if !valid_id(e.s("id"))
                || !seen.insert(e.s("id"))
                || !string(&e["label"], 200)
                || e.s("label").trim().is_empty()
                || !bindings(&e["bindings"], true)
                || !optional(e, "links", |v| {
                    v.is_object()
                        && entries(v).iter().all(|(id, t)| {
                            ids.contains(id.as_str())
                                && t.is_object()
                                && entries(t).len() <= 500
                                && entries(t)
                                    .iter()
                                    .all(|(p, t)| path_key(p) && t.as_str().is_some_and(valid_id))
                        })
                })
                || !optional(e, "decisions", |v| decisions(v, 1))
                || !optional(e, "skipped", |v| {
                    v.is_array()
                        && v.list().len() <= 2000
                        && v.list().iter().all(|v| v.is_string() && path_key(v.text()))
                })
                || !optional(e, "automation", |v| {
                    valid_id(v.s("id")) && string(&v["name"], 100)
                })
                || !optional(e, "runId", |v| v.as_str().is_some_and(valid_id))
                || !optional(e, "inputs", inputs)
                || !optional(e, "loops", |v| {
                    v.is_object()
                        && entries(v)
                            .iter()
                            .all(|(id, c)| valid_id(id) && integer(c, 0., 200.))
                })
                || !optional(e, "history", history)
                || !optional(e, "values", |v| {
                    v.is_object() && entries(v).iter().all(|(k, v)| key(k) && valid_value(v))
                })
                || !optional(e, "spawned", |v| spawned(v, &ids))
            {
                return Err("실행 ID·이름·Task 연결이 올바르지 않습니다.".into());
            }
        }
    }
    Ok(model::serializable(&g))
}
