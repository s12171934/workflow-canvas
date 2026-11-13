use crate::geometry::{Point, Rect};
use crate::{JsonExt, model, object};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Deserialize)]
struct BoxNode {
    id: String,
    width: f64,
    height: f64,
    #[serde(default)]
    ports: Option<usize>,
    #[serde(default, rename = "virtual")]
    virtual_: bool,
}
#[derive(Clone, Deserialize)]
struct NamedLink {
    source: String,
    target: String,
    #[serde(default)]
    port: Option<usize>,
}
#[derive(Clone)]
struct Link {
    source: usize,
    target: usize,
    port: Option<usize>,
}
struct ResultLayout {
    positions: HashMap<String, Point>,
    size: Size,
}
pub fn estimated(n: &Value) -> Size {
    if n["measured"].n("width") != 0. && n["measured"].n("height") != 0. {
        return Size {
            width: n["measured"].n("width"),
            height: n["measured"].n("height"),
        };
    }
    if model::group(n) || model::frame(n) {
        return Size {
            width: n.get("width").and_then(Value::as_f64).unwrap_or(560.),
            height: n.get("height").and_then(Value::as_f64).unwrap_or(320.),
        };
    }
    if n["data"].s("kind") == "note" && n.n("width") != 0. && n.n("height") != 0. {
        return Size {
            width: n.n("width"),
            height: n.n("height"),
        };
    }
    let outputs = if model::branch(n) {
        n["data"]
            .get("outputs")
            .map(|v| v.list().len())
            .unwrap_or(2)
    } else {
        0
    };
    Size {
        width: 254.,
        height: if n["data"].s("kind") == "note" {
            110.
        } else {
            150. + outputs as f64 * 26.
        },
    }
}
fn measure(n: &Value, sizes: &Value) -> Size {
    sizes
        .get(n.s("id"))
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_else(|| estimated(n))
}
fn absolute_rect(
    i: usize,
    nodes: &[Value],
    sizes: &Value,
    cache: &mut Vec<Option<Rect>>,
    depth: usize,
) -> Rect {
    if let Some(r) = cache[i] {
        return r;
    }
    let n = &nodes[i];
    let p = if depth < 50 {
        nodes.iter().position(|p| p.s("id") == n.s("parentId"))
    } else {
        None
    };
    let base = p
        .map(|i| absolute_rect(i, nodes, sizes, cache, depth + 1))
        .unwrap_or_default();
    let s = if model::group(n) || model::frame(n) {
        Size {
            width: n
                .get("width")
                .or(n["measured"].get("width"))
                .and_then(Value::as_f64)
                .unwrap_or(560.),
            height: n
                .get("height")
                .or(n["measured"].get("height"))
                .and_then(Value::as_f64)
                .unwrap_or(320.),
        }
    } else {
        measure(n, sizes)
    };
    let r = Rect {
        x: base.x + n["position"].n("x"),
        y: base.y + n["position"].n("y"),
        width: s.width,
        height: s.height,
    };
    cache[i] = Some(r);
    r
}
fn ancestor(cluster: &[Option<usize>], inner: usize, outer: usize) -> bool {
    let mut at = cluster[inner];
    for _ in 0..50 {
        let Some(i) = at else { break };
        if i == outer {
            return true;
        }
        at = cluster[i]
    }
    false
}
fn arrange(
    parent: Option<usize>,
    nodes: &[Value],
    edges: &[Value],
    input_sizes: &Value,
    cluster: &[Option<usize>],
    positions: &mut Vec<Point>,
    sizes: &mut Vec<Size>,
    depth: usize,
) -> Size {
    if depth > 50 {
        return Size::default();
    }
    let members: Vec<usize> = (0..nodes.len()).filter(|&i| cluster[i] == parent).collect();
    for &i in &members {
        if cluster.contains(&Some(i)) {
            let inner = arrange(
                Some(i),
                nodes,
                edges,
                input_sizes,
                cluster,
                positions,
                sizes,
                depth + 1,
            );
            sizes[i] = Size {
                width: (inner.width + 48.).max(300.),
                height: (inner.height + 68.).max(200.),
            }
        } else {
            sizes[i] = if model::group(&nodes[i]) || model::frame(&nodes[i]) {
                Size {
                    width: nodes[i]
                        .get("width")
                        .and_then(Value::as_f64)
                        .unwrap_or(560.),
                    height: nodes[i]
                        .get("height")
                        .and_then(Value::as_f64)
                        .unwrap_or(320.),
                }
            } else {
                measure(&nodes[i], input_sizes)
            }
        }
    }
    let lift = |id: &str| {
        let mut at = nodes.iter().position(|n| n.s("id") == id);
        for _ in 0..=nodes.len() {
            let Some(i) = at else { break };
            if members.contains(&i) {
                return Some(i);
            }
            at = cluster[i]
        }
        None
    };
    let mut links = vec![];
    let mut seen = HashSet::new();
    for e in edges
        .iter()
        .filter(|e| e["loop"].is_null() && e.s("source") != e.s("target"))
    {
        let (Some(source), Some(target)) = (lift(e.s("source")), lift(e.s("target"))) else {
            continue;
        };
        if source == target {
            continue;
        }
        let port = if nodes[source].s("id") == e.s("source")
            && model::branch(&nodes[source])
            && !e.s("sourceHandle").is_empty()
        {
            Some(
                nodes[source]["data"]
                    .a("outputs")
                    .iter()
                    .position(|p| p.s("id") == e.s("sourceHandle"))
                    .unwrap_or(0),
            )
        } else {
            None
        };
        if seen.insert((source, target, port)) {
            links.push(NamedLink {
                source: nodes[source].s("id").into(),
                target: nodes[target].s("id").into(),
                port,
            })
        }
    }
    let boxes: Vec<BoxNode> = members
        .iter()
        .map(|&i| BoxNode {
            id: nodes[i].s("id").into(),
            width: sizes[i].width,
            height: sizes[i].height,
            ports: if model::branch(&nodes[i]) {
                Some(
                    nodes[i]["data"]
                        .get("outputs")
                        .map(|v| v.list().len())
                        .unwrap_or(2),
                )
            } else {
                None
            },
            virtual_: false,
        })
        .collect();
    let result = layered(&boxes, &links);
    for i in members {
        positions[i] = result
            .positions
            .get(nodes[i].s("id"))
            .copied()
            .unwrap_or_default()
    }
    result.size
}
fn absolute_point(
    i: usize,
    cluster: &[Option<usize>],
    placed: &[Point],
    cache: &mut Vec<Option<Point>>,
    depth: usize,
) -> Point {
    if let Some(p) = cache[i] {
        return p;
    }
    let base = if depth < 50 {
        cluster[i]
            .map(|p| {
                let point = absolute_point(p, cluster, placed, cache, depth + 1);
                Point {
                    x: point.x + 24.,
                    y: point.y + 44.,
                }
            })
            .unwrap_or_default()
    } else {
        Point::default()
    };
    let p = Point {
        x: base.x + placed[i].x,
        y: base.y + placed[i].y,
    };
    cache[i] = Some(p);
    p
}
pub fn auto_layout(nodes: &[Value], edges: &[Value], input_sizes: &Value) -> Value {
    if nodes.is_empty() {
        return json!([]);
    }
    let mut rects = vec![None; nodes.len()];
    for i in 0..nodes.len() {
        absolute_rect(i, nodes, input_sizes, &mut rects, 0);
    }
    let mut named_rects = object();
    for (i, n) in nodes.iter().enumerate() {
        named_rects[n.s("id")] = serde_json::to_value(rects[i].unwrap()).unwrap()
    }
    let mut cluster: Vec<Option<usize>> = nodes
        .iter()
        .map(|n| {
            nodes
                .iter()
                .position(|p| !n.s("parentId").is_empty() && p.s("id") == n.s("parentId"))
        })
        .collect();
    let mut frames: Vec<usize> = (0..nodes.len())
        .filter(|&i| model::frame(&nodes[i]))
        .collect();
    frames.sort_by(|&a, &b| {
        let a = rects[a].unwrap();
        let b = rects[b].unwrap();
        (b.width * b.height).total_cmp(&(a.width * a.height))
    });
    for i in frames {
        for id in model::frame_contents(nodes[i].s("id"), nodes, &named_rects) {
            if let Some(j) = nodes.iter().position(|n| n.s("id") == id) {
                if j != i && cluster[j] == cluster[i] && !ancestor(&cluster, i, j) {
                    cluster[j] = Some(i)
                }
            }
        }
    }
    let mut placed = vec![Point::default(); nodes.len()];
    let mut sizes = vec![Size::default(); nodes.len()];
    arrange(
        None,
        nodes,
        edges,
        input_sizes,
        &cluster,
        &mut placed,
        &mut sizes,
        0,
    );
    let mut cache = vec![None; nodes.len()];
    json!(
        nodes
            .iter()
            .enumerate()
            .map(|(i, n)| {
                let at = absolute_point(i, &cluster, &placed, &mut cache, 0);
                let parent = nodes
                    .iter()
                    .position(|p| !n.s("parentId").is_empty() && p.s("id") == n.s("parentId"))
                    .map(|p| absolute_point(p, &cluster, &placed, &mut cache, 0))
                    .unwrap_or_default();
                let mut out = n.clone();
                out["position"] =
                    json!({"x":(at.x-parent.x+0.5).floor(),"y":(at.y-parent.y+0.5).floor()});
                if model::group(n) || model::frame(n) {
                    out["width"] = json!(sizes[i].width);
                    out["height"] = json!(sizes[i].height)
                }
                out
            })
            .collect::<Vec<_>>()
    )
}
fn root(parents: &mut [usize], i: usize) -> usize {
    if parents[i] != i {
        parents[i] = root(parents, parents[i])
    }
    parents[i]
}
fn layered(boxes: &[BoxNode], links: &[NamedLink]) -> ResultLayout {
    let mut positions = HashMap::new();
    if boxes.is_empty() {
        return ResultLayout {
            positions,
            size: Size::default(),
        };
    }
    let index: HashMap<&str, usize> = boxes
        .iter()
        .enumerate()
        .map(|(i, b)| (b.id.as_str(), i))
        .collect();
    let mut parents: Vec<usize> = (0..boxes.len()).collect();
    for l in links {
        if let (Some(&a), Some(&b)) = (index.get(l.source.as_str()), index.get(l.target.as_str())) {
            let a = root(&mut parents, a);
            let b = root(&mut parents, b);
            parents[a] = b;
        }
    }
    let mut groups: Vec<(usize, Vec<BoxNode>)> = vec![];
    for (i, b) in boxes.iter().enumerate() {
        let p = root(&mut parents, i);
        if let Some((_, group)) = groups.iter_mut().find(|(id, _)| *id == p) {
            group.push(b.clone())
        } else {
            groups.push((p, vec![b.clone()]))
        }
    }
    let single: Vec<BoxNode> = groups
        .iter()
        .filter(|(_, g)| g.len() == 1)
        .map(|(_, g)| g[0].clone())
        .collect();
    let mut parts: Vec<ResultLayout> = groups
        .iter()
        .filter(|(_, g)| g.len() > 1)
        .map(|(_, g)| {
            let ids: HashSet<&str> = g.iter().map(|b| b.id.as_str()).collect();
            component(
                g,
                &links
                    .iter()
                    .filter(|l| ids.contains(l.source.as_str()))
                    .cloned()
                    .collect::<Vec<_>>(),
            )
        })
        .collect();
    parts.sort_by(|a, b| (b.size.width * b.size.height).total_cmp(&(a.size.width * a.size.height)));
    let (mut y, mut width) = (0f64, 0f64);
    for part in parts {
        for (id, p) in part.positions {
            positions.insert(id, Point { x: p.x, y: p.y + y });
        }
        y += part.size.height + 60.;
        width = width.max(part.size.width);
    }
    if !single.is_empty() {
        let limit = width.max(902.);
        let (mut x, mut rh) = (0., 0f64);
        for b in single {
            if x > 0. && x + b.width > limit {
                x = 0.;
                y += rh + 34.;
                rh = 0.
            }
            positions.insert(b.id, Point { x, y });
            x += b.width + 70.;
            rh = rh.max(b.height);
            width = width.max(x - 70.);
        }
        y += rh + 60.;
    }
    ResultLayout {
        positions,
        size: Size {
            width,
            height: (y - 60.).max(0.),
        },
    }
}
fn dfs(i: usize, links: &[Link], state: &mut [u8], out: &mut Vec<Link>) {
    state[i] = 1;
    for l in links.iter().filter(|l| l.source == i) {
        if state[l.target] == 1 {
            continue;
        }
        out.push(l.clone());
        if state[l.target] == 0 {
            dfs(l.target, links, state, out)
        }
    }
    state[i] = 2;
}
fn layer_of(i: usize, preds: &[Vec<usize>], layers: &mut [Option<usize>], depth: usize) -> usize {
    if let Some(l) = layers[i] {
        return l;
    }
    let l = if depth > preds.len() {
        0
    } else {
        preds[i]
            .iter()
            .map(|&p| layer_of(p, preds, layers, depth + 1) + 1)
            .max()
            .unwrap_or(0)
    };
    layers[i] = Some(l);
    l
}
fn seed(
    i: usize,
    down: &[Vec<Link>],
    layer: &[usize],
    layers: &mut [Vec<usize>],
    seen: &mut HashSet<usize>,
) {
    if !seen.insert(i) {
        return;
    }
    layers[layer[i]].push(i);
    let mut links = down[i].clone();
    links.sort_by_key(|l| l.port.unwrap_or(0));
    for l in links {
        seed(l.target, down, layer, layers, seen)
    }
}
fn ranks(layers: &[Vec<usize>], n: usize) -> Vec<f64> {
    let mut rank = vec![0.; n];
    for items in layers {
        for (i, &id) in items.iter().enumerate() {
            rank[id] = i as f64
        }
    }
    rank
}
fn port_offset(l: &Link, size: &[BoxNode]) -> f64 {
    match (l.port, size[l.source].ports) {
        (Some(p), Some(n)) if n > 0 => (p as f64 + 0.5) / n as f64 - 0.5,
        _ => 0.,
    }
}
fn crossings(layers: &[Vec<usize>], down: &[Vec<Link>], size: &[BoxNode]) -> usize {
    let rank = ranks(layers, size.len());
    let mut count = 0;
    for items in layers.iter().take(layers.len().saturating_sub(1)) {
        let mut segments = vec![];
        for &i in items {
            for l in &down[i] {
                segments.push((rank[i] + port_offset(l, size), rank[l.target]));
            }
        }
        for i in 0..segments.len() {
            for j in i + 1..segments.len() {
                if (segments[i].0 - segments[j].0) * (segments[i].1 - segments[j].1) < 0. {
                    count += 1
                }
            }
        }
    }
    count
}
fn anchor(l: &Link, source: bool, size: &[BoxNode], y: &[f64]) -> f64 {
    let i = if source { l.source } else { l.target };
    if source {
        if let (Some(p), Some(n)) = (l.port, size[i].ports) {
            if n > 0 {
                return y[i] + size[i].height * (0.45 + 0.5 * (p as f64 + 0.5) / n as f64);
            }
        }
    }
    y[i] + size[i].height / 2.
}
fn desired(
    i: usize,
    kind: u8,
    up: &[Vec<Link>],
    down: &[Vec<Link>],
    size: &[BoxNode],
    y: &[f64],
) -> Option<f64> {
    let mut v = vec![];
    if kind != 2 {
        v.extend(up[i].iter().map(|l| anchor(l, true, size, y)))
    }
    if kind != 0 {
        v.extend(down[i].iter().map(|l| {
            anchor(l, false, size, y)
                - (anchor(l, true, size, y) - y[l.source] - size[l.source].height / 2.)
        }))
    }
    if v.is_empty() {
        None
    } else {
        Some(v.iter().sum::<f64>() / v.len() as f64)
    }
}
fn settle(
    items: &[usize],
    kind: u8,
    up: &[Vec<Link>],
    down: &[Vec<Link>],
    size: &[BoxNode],
    y: &mut [f64],
) {
    let want: Vec<f64> = items
        .iter()
        .map(|&i| {
            desired(i, kind, up, down, size, y)
                .map(|w| w - size[i].height / 2.)
                .unwrap_or(y[i])
        })
        .collect();
    let mut offset = vec![0.; items.len()];
    for i in 1..items.len() {
        offset[i] = offset[i - 1]
            + size[items[i - 1]].height
            + if size[items[i - 1]].virtual_ && size[items[i]].virtual_ {
                12.
            } else {
                34.
            }
    }
    let mut blocks: Vec<(usize, usize, f64, usize)> = vec![];
    for i in 0..items.len() {
        blocks.push((i, i, want[i] - offset[i], 1));
        while blocks.len() > 1 {
            let a = blocks[blocks.len() - 2];
            let b = blocks[blocks.len() - 1];
            if a.2 / a.3 as f64 <= b.2 / b.3 as f64 {
                break;
            }
            blocks.pop();
            blocks.pop();
            blocks.push((a.0, b.1, a.2 + b.2, a.3 + b.3));
        }
    }
    for (a, b, sum, count) in blocks {
        for i in a..=b {
            y[items[i]] = sum / count as f64 + offset[i]
        }
    }
}
fn component(boxes: &[BoxNode], links: &[NamedLink]) -> ResultLayout {
    let index: HashMap<&str, usize> = boxes
        .iter()
        .enumerate()
        .map(|(i, b)| (b.id.as_str(), i))
        .collect();
    let links: Vec<Link> = links
        .iter()
        .filter_map(|l| {
            Some(Link {
                source: *index.get(l.source.as_str())?,
                target: *index.get(l.target.as_str())?,
                port: l.port,
            })
        })
        .collect();
    let mut state = vec![0; boxes.len()];
    let mut acyclic = vec![];
    for i in 0..boxes.len() {
        if state[i] == 0 {
            dfs(i, &links, &mut state, &mut acyclic)
        }
    }
    let mut preds = vec![vec![]; boxes.len()];
    let mut succs = preds.clone();
    for l in &acyclic {
        preds[l.target].push(l.source);
        succs[l.source].push(l.target)
    }
    let mut layers_opt = vec![None; boxes.len()];
    for i in 0..boxes.len() {
        layer_of(i, &preds, &mut layers_opt, 0);
    }
    let mut layer: Vec<usize> = layers_opt.iter().map(|v| v.unwrap()).collect();
    for i in 0..boxes.len() {
        if preds[i].is_empty() && !succs[i].is_empty() {
            layer[i] = succs[i]
                .iter()
                .map(|&s| layer[s])
                .min()
                .unwrap()
                .saturating_sub(1)
        }
    }
    let mut size = boxes.to_vec();
    let mut chain = vec![];
    let mut virtual_count = 0;
    for l in acyclic {
        let mut from = l.source;
        let mut port = l.port;
        for at in layer[l.source] + 1..layer[l.target] {
            let id = size.len();
            size.push(BoxNode {
                id: format!("\0v{virtual_count}"),
                width: 0.,
                height: 8.,
                virtual_: true,
                ports: None,
            });
            virtual_count += 1;
            layer.push(at);
            chain.push(Link {
                source: from,
                target: id,
                port,
            });
            from = id;
            port = None;
        }
        chain.push(Link {
            source: from,
            target: l.target,
            port,
        });
    }
    let count = layer.iter().max().unwrap() + 1;
    let mut layers = vec![vec![]; count];
    let mut up = vec![vec![]; size.len()];
    let mut down = up.clone();
    for l in chain {
        down[l.source].push(l.clone());
        up[l.target].push(l)
    }
    let mut seen = HashSet::new();
    for i in 0..boxes.len() {
        if up[i].is_empty() {
            seed(i, &down, &layer, &mut layers, &mut seen)
        }
    }
    for i in 0..size.len() {
        seed(i, &down, &layer, &mut layers, &mut seen)
    }
    let mut best = layers.clone();
    let mut best_count = crossings(&layers, &down, &size);
    for sweep in 0..12 {
        if best_count == 0 {
            break;
        }
        let downward = sweep % 2 == 0;
        for step in 0..count {
            let l = if downward { step } else { count - 1 - step };
            let rank = ranks(&layers, size.len());
            let mut keyed: Vec<(usize, f64, f64)> = layers[l]
                .iter()
                .map(|&i| {
                    let list: Vec<f64> = if downward {
                        up[i]
                            .iter()
                            .map(|l| rank[l.source] + port_offset(l, &size))
                            .collect()
                    } else {
                        down[i]
                            .iter()
                            .map(|l| rank[l.target] - port_offset(l, &size))
                            .collect()
                    };
                    (
                        i,
                        if list.is_empty() {
                            rank[i]
                        } else {
                            list.iter().sum::<f64>() / list.len() as f64
                        },
                        rank[i],
                    )
                })
                .collect();
            keyed.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.2.total_cmp(&b.2)));
            layers[l] = keyed.into_iter().map(|k| k.0).collect();
        }
        let crossings = crossings(&layers, &down, &size);
        if crossings < best_count {
            best_count = crossings;
            best = layers.clone()
        }
    }
    layers = best;
    let mut y = vec![0.; size.len()];
    let mut at = 0.;
    for &i in &layers[0] {
        y[i] = at;
        at += size[i].height + 34.;
    }
    for l in 1..count {
        settle(&layers[l], 0, &up, &down, &size, &mut y)
    }
    for _ in 0..4 {
        for l in (0..count - 1).rev() {
            settle(&layers[l], 1, &up, &down, &size, &mut y)
        }
        for l in 1..count {
            settle(&layers[l], 1, &up, &down, &size, &mut y)
        }
    }
    let widths: Vec<f64> = layers
        .iter()
        .map(|l| l.iter().map(|&i| size[i].width).fold(0., f64::max))
        .collect();
    let real: Vec<Vec<usize>> = layers
        .iter()
        .map(|l| l.iter().filter(|&&i| !size[i].virtual_).copied().collect())
        .collect();
    let extent = |from: usize, to: usize| {
        let items: Vec<usize> = real[from..to].iter().flatten().copied().collect();
        (
            items.iter().map(|&i| y[i]).fold(f64::INFINITY, f64::min),
            items
                .iter()
                .map(|&i| y[i] + size[i].height)
                .fold(f64::NEG_INFINITY, f64::max),
        )
    };
    let span = |from: usize, to: usize| {
        widths[from..to].iter().sum::<f64>() + (to - from - 1) as f64 * 70.
    };
    let plan = |n: usize| {
        let target = span(0, count) / n as f64;
        let mut bands = vec![];
        let mut start = 0;
        for l in 1..=count {
            let left = n.saturating_sub(bands.len() + 1);
            if l == count || (left > 0 && span(start, l + 1) > target && count - l >= left) {
                bands.push((start, l));
                start = l
            }
        }
        let width = bands.iter().map(|&(a, b)| span(a, b)).fold(0., f64::max);
        let height = bands
            .iter()
            .map(|&(a, b)| {
                let (t, bt) = extent(a, b);
                bt - t
            })
            .sum::<f64>()
            + (bands.len() - 1) as f64 * 90.;
        let thin = bands.iter().any(|&(a, b)| b - a < 2 && widths[a] < 600.);
        let scale = if thin {
            f64::INFINITY
        } else {
            (width / 16.).max(height / 9.)
        };
        (bands, width, scale)
    };
    let mut chosen = plan(1);
    for n in 2..=count.min(8) {
        if chosen.1 <= 2000. {
            break;
        }
        let option = plan(n);
        if option.2 < chosen.2 * 0.9 {
            chosen = option
        }
    }
    let mut positions = HashMap::new();
    let mut band_top = 0.;
    for (from, to) in chosen.0 {
        let (top, bottom) = extent(from, to);
        let mut x = 0.;
        for l in from..to {
            for &i in &real[l] {
                positions.insert(
                    size[i].id.clone(),
                    Point {
                        x: x + (widths[l] - size[i].width) / 2.,
                        y: (y[i] - top + band_top + 0.5).floor(),
                    },
                );
            }
            x += widths[l] + 70.;
        }
        band_top += bottom - top + 90.;
    }
    ResultLayout {
        positions,
        size: Size {
            width: chosen.1,
            height: (band_top - 90. + 0.5).floor(),
        },
    }
}
pub fn layered_json(boxes: &Value, links: &Value) -> Value {
    let boxes: Vec<BoxNode> = serde_json::from_value(boxes.clone()).unwrap_or_default();
    let links: Vec<NamedLink> = serde_json::from_value(links.clone()).unwrap_or_default();
    let r = layered(&boxes, &links);
    json!({"positions":r.positions,"size":r.size})
}
