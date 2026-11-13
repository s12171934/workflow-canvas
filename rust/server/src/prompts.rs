use serde_json::{Value, json};
use workflow_core::{JsonExt, model, workflow};
pub fn render(template: &str, values: &[String]) -> String {
    let re = regex::Regex::new(r"@@(\d+)@@").unwrap();
    re.replace_all(template, |m: &regex::Captures| {
        values
            .get(m[1].parse::<usize>().unwrap())
            .cloned()
            .unwrap_or_default()
    })
    .to_string()
}
fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap()
}
fn truncated(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}
fn scan(stages: &[Value], f: fn(&Value) -> bool) -> bool {
    stages
        .iter()
        .any(|s| f(s) || scan(s["workflow"].a("stages"), f))
}
fn files(stages: &[Value]) -> Vec<Value> {
    let mut out = vec![];
    for s in stages {
        if !s.s("instructionsFile").is_empty() {
            out.push(json!({"path":s["instructionsFile"],"content":format!("# {}\n\n{}\n",s.s("label"),s.s("instructions"))}))
        }
        out.extend(files(s["workflow"].a("stages")));
    }
    out
}
pub fn compose(i: &Value) -> std::result::Result<Value, String> {
    let graph = &i["graph"];
    let linked = i.get("linked").cloned().unwrap_or(json!({}));
    let count = i.n("count") as usize;
    let title = i.s("title").replace(['"', '`', '\'', '\\'], "");
    let labels: Vec<String> = (1..=count)
        .map(|n| {
            if title.is_empty() {
                format!("#{n}")
            } else if count > 1 {
                format!("{title} #{n}")
            } else {
                title.clone()
            }
        })
        .collect();
    let api = i.s("apiBase");
    let dir = i.s("artifactDir");
    let launch = i.s("launchId");
    let settings = i.get("values").cloned().unwrap_or_else(|| {
        model::resolve_variables(&graph["variables"], &Value::Null)["values"].clone()
    });
    let mut ctx = workflow::Context {
        linked: &linked,
        project: i.s("workspace"),
        inputs: &i["inputs"],
        values: settings.clone(),
        worktrees: vec![],
        prepared: i.s("preparedGroup"),
        instructions: Some(format!("{dir}/instructions")),
    };
    let stages = workflow::stages(graph, &mut ctx, i.s("workspace"), "")?;
    let user = scan(&stages, |s| {
        s.s("kind") == "branch" && s["branch"].s("judge") == "user"
    });
    let subspawn = scan(&stages, |s| s["spawn"].s("as") == "subcoordinator");
    let automation = &i["automation"];
    let automation_json = if automation.is_null() {
        String::new()
    } else {
        format!(",\"automation\":{automation}")
    };
    let sub = if i["subcoordinator"].is_null() {
        String::new()
    } else {
        render(
            include_str!("../prompts/execute-4.txt"),
            &[i["subcoordinator"].s("parentName").replace('`', "'")],
        )
    };
    let trees = if ctx.worktrees.is_empty() {
        String::new()
    } else {
        render(
            include_str!("../prompts/execute-5.txt"),
            &[pretty(&json!(ctx.worktrees))],
        )
    };
    let variables = if graph.a("variables").is_empty() {
        String::new()
    } else {
        let lines = graph
            .a("variables")
            .iter()
            .map(|v| {
                let key = v.s("key");
                format!(
                    "  - `{key}` {}: {}",
                    v.s("label"),
                    if settings.s(key).is_empty() {
                        "(없음)".into()
                    } else {
                        format!("`{}`", settings.s(key).replace('`', "'"))
                    }
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        render(include_str!("../prompts/execute-8.txt"), &[lines])
    };
    let resume = render(
        include_str!("../prompts/execute-2.txt"),
        &[
            api.into(),
            graph.s("id").into(),
            if launch.is_empty() {
                "캔버스 실행 로그".into()
            } else {
                format!(
                    "`curl -s {api}/api/workflows/{}/logs/{launch}`",
                    graph.s("id")
                )
            },
            dir.into(),
            dir.into(),
            dir.into(),
        ],
    );
    let cleanup = i
        .get("cleanup")
        .cloned()
        .unwrap_or(json!({"sessions":true,"worktrees":false,"coordinator":false}));
    let mut values = vec![String::new(); 47];
    values[0] = if automation.is_null() {
        "workflow-canvas 의 \"실행\" 버튼".into()
    } else {
        format!("Orca 자동화 「{}」", automation.s("name"))
    };
    if !automation.is_null() {
        values[1] = render(
            include_str!("../prompts/execute-7.txt"),
            &[automation.to_string().replace('`', "")],
        )
    }
    values[2] = count.to_string();
    values[3] = sub;
    values[4] = graph.s("name").into();
    values[5] = graph.s("id").into();
    values[6] = i.s("workspace").into();
    values[7] = variables;
    values[8] = pretty(&json!(stages));
    values[9] = trees;
    values[10] = graph.s("name").replace('"', "'");
    values[11] = count.to_string();
    values[12] = count.to_string();
    values[13] = labels
        .iter()
        .enumerate()
        .map(|(n, s)| format!("{} → `{s}`", n + 1))
        .collect::<Vec<_>>()
        .join(", ");
    values[14] = api.into();
    values[15] = graph.s("id").into();
    if !launch.is_empty() {
        values[16] =
            format!("\"launch\":\"{launch}\",\"coordinatorTerminal\":\"<네 터미널 핸들>\",");
        values[19] = include_str!("../prompts/execute-9.txt").into()
    }
    values[17] = labels.first().cloned().unwrap_or_default();
    values[18] = automation_json.replace('\'', "");
    values[20] = truncated(graph.s("name"), 30);
    values[21] = include_str!("../prompts/execute-1.txt").into();
    if user {
        values[22] = render(
            include_str!("../prompts/execute-10.txt"),
            &[api.into(), graph.s("id").into(), dir.into()],
        );
        values[41] = render(
            include_str!("../prompts/execute-12.txt"),
            &["## 앞 사용자 분기 판정".into(), dir.into()],
        )
    }
    values[23] = truncated(graph.s("name"), 30);
    for idx in [24, 27, 28, 40, 42, 43] {
        values[idx] = dir.into()
    }
    for idx in [25, 30, 34, 36] {
        values[idx] = api.into()
    }
    for idx in [26, 31, 35, 37] {
        values[idx] = graph.s("id").into()
    }
    values[29] = "20".into();
    values[32] = i.s("workspace").into();
    if subspawn {
        values[33] = include_str!("../prompts/execute-3.txt").into()
    }
    values[38] = resume;
    if !i.s("logUrl").is_empty() {
        values[39] = render(
            include_str!("../prompts/execute-11.txt"),
            &[i.s("logUrl").into()],
        )
    }
    values[44] = if cleanup.b("sessions") {
        include_str!("../prompts/cleanup-44-yes.txt")
    } else {
        include_str!("../prompts/cleanup-44-no.txt")
    }
    .into();
    values[45] = if cleanup.b("worktrees") {
        include_str!("../prompts/cleanup-45-yes.txt")
    } else {
        include_str!("../prompts/cleanup-45-no.txt")
    }
    .into();
    values[46] = render(
        if cleanup.b("coordinator") {
            include_str!("../prompts/cleanup-46-yes.txt")
        } else {
            include_str!("../prompts/cleanup-46-no.txt")
        },
        &[dir.into()],
    );
    Ok(
        json!({"brief":render(include_str!("../prompts/execute-6.txt"),&values),"files":files(&stages)}),
    )
}
fn contract() -> String {
    format!(
        "## 런타임 계약\n지침은 아래 런타임 동작을 전제로 쓴다. 지침 안에서 이 동작을 다르게 가정하거나 다시 정의하지 않는다.\n\n{}\n",
        serde_json::from_str::<Value>(include_str!("../../../exports/runtime-contract.json"))
            .unwrap()
            .list()
            .iter()
            .map(|item| format!("- **{}** — {}", item.s("title"), item.s("text")))
            .collect::<Vec<_>>()
            .join("\n")
    )
}
fn result_format(i: &Value) -> String {
    render(
        include_str!("../prompts/generate-0.txt"),
        &[
            i.s("resultFile").into(),
            i.s("resultUrl").into(),
            i.s("resultFile").into(),
        ],
    )
}
pub fn workflow_prompt(i: &Value) -> String {
    let models = if i["models"].is_array() {
        workflow_core::strings(&i["models"])
    } else {
        model::MODELS.iter().map(|s| s.to_string()).collect()
    };
    let saved = if i.a("saved").is_empty() {
        "- (없음)".into()
    } else {
        i.a("saved")
            .iter()
            .map(|s| format!("- `{}` {}", s.s("id"), s.s("name")))
            .collect::<Vec<_>>()
            .join("\n")
    };
    render(
        include_str!("../prompts/generate-1.txt"),
        &[
            i.s("request").into(),
            models.join(", "),
            model::DEFAULT_MODEL.into(),
            "low, medium, high, xhigh, max".into(),
            contract(),
            saved,
            result_format(i),
        ],
    )
}
fn kind_name(kind: &str) -> &str {
    match kind {
        "worker" => "워커",
        "gate" => "사용자 개입 게이트",
        "branch" => "분기",
        "script" => "스크립트 드라이버",
        "note" => "메모",
        "workflow" => "워크플로 링크",
        "group" => "그룹",
        "frame" => "메모 그룹",
        _ => kind,
    }
}
pub fn brief_prompt(i: &Value) -> String {
    let g = &i["graph"];
    let id = i.s("nodeId");
    let n = model::find(g.a("nodes"), id).unwrap_or(&Value::Null);
    let d = &n["data"];
    let ids = g
        .a("nodes")
        .iter()
        .filter(|n| model::executable(n))
        .map(|n| n.s("id").into())
        .collect::<Vec<_>>();
    let edges = g
        .a("edges")
        .iter()
        .filter(|e| e["loop"].is_null())
        .cloned()
        .collect::<Vec<_>>();
    let order = model::topological(&ids, &edges);
    let role=match d.s("kind"){"gate"=>"사용자에게 물을 내용(무엇을 확인하고 어떤 기준으로 통과·거절할지)".into(),"branch"=>format!("판정 지침(무엇을 근거로 출력을 고를지). 출력: {}",if d.a("outputs").is_empty(){"(없음)".into()}else{d.a("outputs").iter().map(|o|format!("{}={}",o.s("id"),o.s("label"))).collect::<Vec<_>>().join(", ")}),"workflow"=>"링크한 워크플로에 덧붙일 추가 지침".into(),"note"=>"메모 내용".into(),_=>"워커 브리프. 워커가 이것만 읽고 일할 수 있어야 한다: 목표, 작업 범위(건드릴 곳과 건드리지 않을 곳), 제약, 완료 조건, 산출물. 앞 단계 산출물을 쓰면 무엇을 받는지, 뒤 단계가 무엇을 기대하는지도 적는다".into()};
    let lines = order
        .a("order")
        .iter()
        .filter_map(|id| model::find(g.a("nodes"), id.text()))
        .map(|n| {
            format!(
                "- {}{} ({}){}",
                if n.s("id") == id {
                    "**[이 단계]** "
                } else {
                    ""
                },
                if n["data"].s("label").is_empty() {
                    "(이름 없음)"
                } else {
                    n["data"].s("label")
                },
                kind_name(n["data"].s("kind")),
                if n["data"].s("description").is_empty() {
                    String::new()
                } else {
                    format!(
                        ": {}",
                        truncated(
                            &n["data"]
                                .s("description")
                                .split_whitespace()
                                .collect::<Vec<_>>()
                                .join(" "),
                            300
                        )
                    )
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let neighbors = |before: bool| {
        let names = g
            .a("edges")
            .iter()
            .filter(|e| {
                if before {
                    e.s("target") == id
                } else {
                    e.s("source") == id
                }
            })
            .filter_map(|e| {
                model::find(
                    g.a("nodes"),
                    if before { e.s("source") } else { e.s("target") },
                )
            })
            .map(|n| n["data"].s("label"))
            .collect::<Vec<_>>()
            .join(", ");
        if names.is_empty() {
            "없음".into()
        } else {
            names
        }
    };
    render(
        include_str!("../prompts/generate-3.txt"),
        &[
            i.s("request").into(),
            if d.s("label").is_empty() {
                "(이름 없음)"
            } else {
                d.s("label")
            }
            .into(),
            kind_name(d.s("kind")).into(),
            role,
            if d.s("description").is_empty() {
                "(비어 있음)".into()
            } else {
                format!("\n\n{}\n", d.s("description"))
            },
            g.s("name").into(),
            if g.s("description").is_empty() {
                String::new()
            } else {
                format!("{}\n\n", g.s("description"))
            },
            if lines.is_empty() {
                "- (없음)".into()
            } else {
                lines
            },
            neighbors(true),
            neighbors(false),
            contract(),
            result_format(i),
        ],
    )
}
pub fn generated(raw: &Value, id: &str) -> std::result::Result<Value, String> {
    if !raw.is_object() {
        return Err("JSON 객체를 보내세요.".into());
    }
    if !raw["name"].is_string() || raw.s("name").trim().is_empty() {
        return Err("name 이 필요합니다.".into());
    }
    if !raw["nodes"].is_array() || raw.a("nodes").is_empty() {
        return Err("nodes 에 단계가 하나 이상 필요합니다.".into());
    }
    if !raw["edges"].is_array() {
        return Err("edges 배열이 필요합니다(없으면 []).".into());
    }
    let mut nodes = vec![];
    for (index, n) in raw.a("nodes").iter().enumerate() {
        if !n.is_object() {
            return Err(format!("nodes[{index}] 가 객체가 아닙니다."));
        }
        let kind = if n["kind"].is_string() {
            n.s("kind")
        } else {
            "worker"
        };
        if !["worker", "gate", "branch", "workflow", "note"].contains(&kind) {
            return Err(format!(
                "nodes[{index}].kind 는 worker·gate·branch·workflow·note 중 하나여야 합니다."
            ));
        }
        let mut d = json!({"label":n.s("label"),"description":n.s("description"),"kind":kind});
        workflow_core::copy_keys(&mut d, n, &["workerModel", "effort", "join"]);
        workflow_core::copy_keys(
            &mut d,
            n,
            match kind {
                "worker" => &["session"],
                "branch" => &["mode", "judge", "outputs"],
                "gate" => &["asker"],
                "workflow" => &["workflowId", "linkMode"],
                _ => &[],
            },
        );
        nodes.push(json!({"id":n.s("id"),"type":"stage","position":{"x":0,"y":0},"data":d}));
    }
    let mut edges = vec![];
    for (index, e) in raw.a("edges").iter().enumerate() {
        if !e.is_object() {
            return Err(format!("edges[{index}] 가 객체가 아닙니다."));
        }
        let mut out =
            json!({"id":format!("e{}",index+1),"source":e.s("source"),"target":e.s("target")});
        for k in ["label", "sourceHandle"] {
            if !e.s(k).is_empty() {
                out[k] = e[k].clone()
            }
        }
        if e["loop"].is_object() {
            out["loop"] = json!({"max":e["loop"]["max"],"exit":e["loop"].s("exit")})
        }
        if model::find(&nodes, e.s("source")).is_some_and(|n| n["data"].s("kind") == "gate") {
            workflow_core::drop_keys(&mut out, &["sourceHandle"])
        }
        edges.push(out);
    }
    Ok(
        json!({"version":1,"id":id,"name":truncated(raw.s("name").trim(),500),"description":truncated(raw.s("description"),10000),"runId":"","nodes":workflow_core::layout::auto_layout(&nodes,&edges,&Value::Null),"edges":edges}),
    )
}
