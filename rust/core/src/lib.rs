//! The same calculations run natively in the server and synchronously in the browser.
pub mod geometry;
pub mod layout;
pub mod model;
pub mod overview;
pub mod validate;
pub mod workflow;
use serde_json::{Value, json};

pub trait JsonExt {
    fn s(&self, key: &str) -> &str;
    fn n(&self, key: &str) -> f64;
    fn b(&self, key: &str) -> bool;
    fn a(&self, key: &str) -> &[Value];
    fn text(&self) -> &str;
    fn list(&self) -> &[Value];
}
impl JsonExt for Value {
    fn s(&self, key: &str) -> &str {
        self[key].as_str().unwrap_or("")
    }
    fn n(&self, key: &str) -> f64 {
        self[key].as_f64().unwrap_or(0.)
    }
    fn b(&self, key: &str) -> bool {
        self[key].as_bool().unwrap_or(false)
    }
    fn a(&self, key: &str) -> &[Value] {
        self[key].as_array().map(Vec::as_slice).unwrap_or(&[])
    }
    fn text(&self) -> &str {
        self.as_str().unwrap_or("")
    }
    fn list(&self) -> &[Value] {
        self.as_array().map(Vec::as_slice).unwrap_or(&[])
    }
}
pub fn object() -> Value {
    json!({})
}
pub fn entries(v: &Value) -> Vec<(String, Value)> {
    v.as_object()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}
pub fn strings(v: &Value) -> Vec<String> {
    v.list().iter().map(|v| v.text().to_owned()).collect()
}
pub fn has(v: &Value, s: &str) -> bool {
    v.list().iter().any(|x| x.text() == s)
}
pub fn truth(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::String(v) => !v.is_empty(),
        Value::Number(n) => n.as_f64().unwrap_or(0.) != 0.,
        _ => true,
    }
}
pub fn drop_keys(v: &mut Value, keys: &[&str]) {
    if let Some(m) = v.as_object_mut() {
        for k in keys {
            m.shift_remove(*k);
        }
    }
}
pub fn copy_keys(to: &mut Value, from: &Value, keys: &[&str]) {
    for k in keys {
        if from.get(k).is_some() {
            to[*k] = from[*k].clone();
        }
    }
}
pub fn dispatch(op: &str, args: &Value) -> Result<Value, String> {
    match op {
        "estimatedSize" => Ok(serde_json::to_value(layout::estimated(&args[0])).unwrap()),
        "autoLayout" => Ok(layout::auto_layout(
            args[0].list(),
            args[1].list(),
            &args[2],
        )),
        "layered" => Ok(layout::layered_json(&args[0], &args[1])),
        "routeEdge" => geometry::route_json(&args[0], &args[1], &args[2]),
        "simplify" => geometry::simplify_json(&args[0]),
        "roundedPath" => geometry::path_json(&args[0], args[1].as_f64().unwrap_or(8.)),
        "midpoint" => geometry::midpoint_json(&args[0]),
        "validateWorkflow" => validate::validate(&args[0]),
        "overviewEntries" => Ok(overview::overview_entries(args[0].list(), &args[1])),
        "overviewWorkflows" => Ok(overview::overview_workflows(args[0].list())),
        "withoutUnknown" => Ok(overview::without_unknown(&args[0])),
        _ => model::dispatch(op, args),
    }
}

// A small owned-buffer ABI avoids a JS runtime or a generated binding toolchain.
// The caller owns both buffers and releases each exactly once with canvas_free.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn canvas_alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn canvas_free(ptr: *mut u8, len: usize) {
    unsafe {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
    }
}
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn canvas_compute(ptr: *const u8, len: usize) -> u64 {
    let input = unsafe { std::slice::from_raw_parts(ptr, len) };
    let result = serde_json::from_slice::<Value>(input)
        .map_err(|e| e.to_string())
        .and_then(|r| dispatch(r.s("op"), &r["args"]));
    let response = match result {
        Ok(value) => json!({"value":value}),
        Err(error) => json!({"error":error}),
    };
    let bytes = serde_json::to_vec(&response).unwrap().into_boxed_slice();
    let size = bytes.len();
    let ptr = Box::into_raw(bytes) as *mut u8;
    ((ptr as u64) << 32) | size as u64
}
