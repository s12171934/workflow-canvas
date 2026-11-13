use crate::error::{Error, Result};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use workflow_core::{JsonExt, validate};
#[derive(Clone)]
pub struct Store {
    pub root: PathBuf,
}
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    Ok(())
}
pub fn mkdir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
pub fn read_json(path: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
impl Store {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
    pub fn load(&self, id: &str) -> Result<Value> {
        if !validate::valid_id(id) {
            return Err(Error::new(400, "올바르지 않은 워크플로 ID입니다."));
        }
        Ok(validate::validate(&read_json(
            &self.root.join(format!("{id}.json")),
        )?)?)
    }
    pub fn save(&self, g: &Value) -> Result<Value> {
        let graph = validate::validate(g)?;
        mkdir(&self.root)?;
        let temp = self.root.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            write_private(&temp, &serde_json::to_vec_pretty(&graph)?)?;
            fs::rename(&temp, self.root.join(format!("{}.json", graph.s("id"))))?;
            Ok(graph)
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result
    }
    pub fn remove(&self, id: &str) -> Result<()> {
        if !validate::valid_id(id) {
            return Err(Error::new(400, "올바르지 않은 워크플로 ID입니다."));
        }
        fs::remove_file(self.root.join(format!("{id}.json")))?;
        Ok(())
    }
    pub fn list(&self) -> Result<Vec<Value>> {
        mkdir(&self.root)?;
        let mut items = vec![];
        for entry in fs::read_dir(&self.root)?.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "json") {
                if let Ok(g) = read_json(&path).and_then(|g| Ok(validate::validate(&g)?)) {
                    let mut item = json!({"id":g["id"],"name":g["name"]});
                    if !g.a("tags").is_empty() {
                        item["tags"] = g["tags"].clone()
                    }
                    items.push((entry.metadata()?.modified()?, item));
                }
            }
        }
        items.sort_by(|a, b| b.0.cmp(&a.0));
        Ok(items.into_iter().map(|(_, v)| v).collect())
    }
    pub fn seed(&self, examples: &Path) -> Result<Vec<String>> {
        let mut paths: Vec<PathBuf> = fs::read_dir(examples)
            .map(|r| {
                r.flatten()
                    .map(|e| e.path())
                    .filter(|p| p.extension().is_some_and(|e| e == "json"))
                    .collect()
            })
            .unwrap_or_default();
        paths.sort();
        if paths.is_empty() {
            return Ok(vec![]);
        }
        mkdir(&self.root)?;
        let record = self.root.join(".examples.json");
        let mut seeded: Vec<String> = read_json(&record)
            .unwrap_or(json!([]))
            .list()
            .iter()
            .map(|v| v.text().to_owned())
            .collect();
        let mut added = vec![];
        for path in paths {
            let Ok(g) = read_json(&path).and_then(|g| Ok(validate::validate(&g)?)) else {
                continue;
            };
            let id = g.s("id").to_string();
            if seeded.contains(&id) {
                continue;
            }
            seeded.push(id.clone());
            if self.root.join(format!("{id}.json")).exists() {
                continue;
            }
            self.save(&g)?;
            let file = fs::File::options()
                .write(true)
                .open(self.root.join(format!("{id}.json")))?;
            let old = std::time::SystemTime::UNIX_EPOCH;
            file.set_times(fs::FileTimes::new().set_modified(old))?;
            added.push(id);
        }
        write_private(&record, &serde_json::to_vec_pretty(&seeded)?)?;
        Ok(added)
    }
    pub fn linked(&self, g: &Value) -> Result<Value> {
        fn visit(store: &Store, g: &Value, chain: &[String], found: &mut Value) -> Result<()> {
            for n in g
                .a("nodes")
                .iter()
                .filter(|n| n["data"].s("kind") == "workflow")
            {
                let d = &n["data"];
                let id = d.s("workflowId");
                if id.is_empty() {
                    return Err(Error::new(
                        400,
                        format!("'{}' 링크 노드에 연결할 워크플로를 고르세요.", d.s("label")),
                    ));
                }
                if chain.iter().any(|i| i == id) {
                    return Err(Error::new(
                        400,
                        format!("'{}' 링크가 자기 자신을 다시 부릅니다(순환).", d.s("label")),
                    ));
                }
                if chain.len() > 3 {
                    return Err(Error::new(
                        400,
                        "워크플로 링크는 3단계까지만 중첩할 수 있습니다.",
                    ));
                }
                let target = if let Some(t) = found.get(id) {
                    t.clone()
                } else {
                    let t = store.load(id).map_err(|_| {
                        Error::new(
                            400,
                            format!(
                                "'{}' 링크가 가리키는 워크플로를 찾지 못했습니다.",
                                d.s("label")
                            ),
                        )
                    })?;
                    found[id] = t.clone();
                    t
                };
                let mut next = chain.to_vec();
                next.push(id.into());
                visit(store, &target, &next, found)?;
            }
            Ok(())
        }
        let mut found = json!({});
        visit(self, g, &[g.s("id").into()], &mut found)?;
        Ok(found)
    }
}
