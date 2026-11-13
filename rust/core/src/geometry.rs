use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Copy, Default, Debug, Deserialize, Serialize, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
#[derive(Clone, Copy, Default, Debug, Deserialize, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Copy)]
struct Box2 {
    l: f64,
    r: f64,
    t: f64,
    b: f64,
}
impl Box2 {
    fn inside(&self, p: Point) -> bool {
        p.x > self.l && p.x < self.r && p.y > self.t && p.y < self.b
    }
    fn crosses(&self, a: Point, b: Point) -> bool {
        if a.y == b.y {
            a.y > self.t && a.y < self.b && a.x.min(b.x) < self.r && a.x.max(b.x) > self.l
        } else if a.x == b.x {
            a.x > self.l && a.x < self.r && a.y.min(b.y) < self.b && a.y.max(b.y) > self.t
        } else {
            true
        }
    }
}
pub fn simplify(points: &[Point]) -> Vec<Point> {
    let mut out: Vec<Point> = vec![];
    for &p in points {
        if out.last() == Some(&p) {
            continue;
        }
        if out.len() > 1 {
            let a = out[out.len() - 2];
            let b = out[out.len() - 1];
            if (a.x == b.x && b.x == p.x) || (a.y == b.y && b.y == p.y) {
                out.pop();
            }
        }
        out.push(p);
    }
    out
}
#[derive(Clone, Copy, PartialEq)]
struct Entry {
    priority: f64,
    state: usize,
}
// Preserve the original heap's equal-cost ordering: it affects the visible route.
#[derive(Default)]
struct MinHeap(Vec<Entry>);
impl MinHeap {
    fn push(&mut self, value: Entry) {
        self.0.push(value);
        let mut i = self.0.len() - 1;
        while i > 0 {
            let parent = (i - 1) / 2;
            if self.0[parent].priority <= self.0[i].priority {
                break;
            }
            self.0.swap(parent, i);
            i = parent;
        }
    }
    fn pop(&mut self) -> Option<Entry> {
        let top = *self.0.first()?;
        let last = self.0.pop().unwrap();
        if !self.0.is_empty() {
            self.0[0] = last;
            let mut i = 0;
            loop {
                let left = i * 2 + 1;
                let right = left + 1;
                let mut smallest = i;
                if left < self.0.len() && self.0[left].priority < self.0[smallest].priority {
                    smallest = left;
                }
                if right < self.0.len() && self.0[right].priority < self.0[smallest].priority {
                    smallest = right;
                }
                if smallest == i {
                    break;
                }
                self.0.swap(smallest, i);
                i = smallest;
            }
        }
        Some(top)
    }
}
pub fn route(source: Point, target: Point, obstacles: &[Rect]) -> Vec<Point> {
    let start = Point {
        x: source.x + 20.,
        y: source.y,
    };
    let end = Point {
        x: target.x - 20.,
        y: target.y,
    };
    let boxes: Vec<Box2> = obstacles
        .iter()
        .map(|r| Box2 {
            l: r.x - 12.,
            r: r.x + r.width + 12.,
            t: r.y - 12.,
            b: r.y + r.height + 12.,
        })
        .filter(|b| !b.inside(start) && !b.inside(end))
        .collect();
    let wrap = |middle: Vec<Point>| {
        let mut p = vec![source, start];
        p.extend(middle);
        p.extend([end, target]);
        simplify(&p)
    };
    if end.x >= start.x {
        let x = (start.x + end.x) / 2.;
        let p = wrap(vec![Point { x, y: start.y }, Point { x, y: end.y }]);
        if p.windows(2)
            .all(|s| !boxes.iter().any(|b| b.crosses(s[0], s[1])))
        {
            return p;
        }
    }
    let mut xs = vec![start.x, end.x, (start.x + end.x) / 2.];
    let mut ys = vec![start.y, end.y, (start.y + end.y) / 2.];
    for b in &boxes {
        xs.extend([b.l, b.r]);
        ys.extend([b.t, b.b]);
    }
    xs.sort_by(f64::total_cmp);
    xs.dedup();
    ys.sort_by(f64::total_cmp);
    ys.dedup();
    let w = xs.len();
    let h = ys.len();
    let mut blocked = vec![false; w * h];
    let mut right = blocked.clone();
    let mut down = blocked.clone();
    for b in &boxes {
        for j in 0..h {
            for i in 0..w {
                let c = j * w + i;
                let x = xs[i];
                let y = ys[j];
                if b.inside(Point { x, y }) {
                    blocked[c] = true
                }
                if i + 1 < w && y > b.t && y < b.b && x >= b.l && xs[i + 1] <= b.r {
                    right[c] = true
                }
                if j + 1 < h && x > b.l && x < b.r && y >= b.t && ys[j + 1] <= b.b {
                    down[c] = true
                }
            }
        }
    }
    let first = ys.iter().position(|y| *y == start.y).unwrap() * w
        + xs.iter().position(|x| *x == start.x).unwrap();
    let goal = ys.iter().position(|y| *y == end.y).unwrap() * w
        + xs.iter().position(|x| *x == end.x).unwrap();
    let guess = |i: usize, j: usize| (xs[i] - xs[goal % w]).abs() + (ys[j] - ys[goal / w]).abs();
    let mut cost = vec![f64::INFINITY; w * h * 4];
    let mut from = vec![usize::MAX; cost.len()];
    let mut heap = MinHeap::default();
    cost[first * 4] = 0.;
    heap.push(Entry {
        priority: guess(first % w, first / w),
        state: first * 4,
    });
    let mut found = None;
    while let Some(Entry {
        priority, state, ..
    }) = heap.pop()
    {
        let cell = state / 4;
        let dir = state % 4;
        let i = cell % w;
        let j = cell / w;
        if priority > cost[state] + guess(i, j) + 1e-9 {
            continue;
        }
        if cell == goal {
            found = Some(state);
            break;
        }
        for (next, (di, dj)) in [(1, 0), (0, 1), (-1, 0), (0, -1)].iter().enumerate() {
            if next == (dir + 2) % 4 {
                continue;
            }
            let ni = i as i32 + di;
            let nj = j as i32 + dj;
            if ni < 0 || nj < 0 || ni >= w as i32 || nj >= h as i32 {
                continue;
            }
            let ni = ni as usize;
            let nj = nj as usize;
            let t = nj * w + ni;
            if (blocked[t] && t != goal)
                || (next == 0 && right[cell])
                || (next == 2 && right[t])
                || (next == 1 && down[cell])
                || (next == 3 && down[t])
            {
                continue;
            }
            let g = cost[state]
                + (xs[ni] - xs[i]).abs()
                + (ys[nj] - ys[j]).abs()
                + if next != dir { 40. } else { 0. }
                + if t == goal && next != 0 { 40. } else { 0. };
            let key = t * 4 + next;
            if g >= cost[key] {
                continue;
            }
            cost[key] = g;
            from[key] = state;
            heap.push(Entry {
                priority: g + guess(ni, nj),
                state: key,
            });
        }
    }
    if let Some(mut s) = found {
        let mut middle = vec![];
        loop {
            let cell = s / 4;
            middle.push(Point {
                x: xs[cell % w],
                y: ys[cell / w],
            });
            if from[s] == usize::MAX {
                break;
            }
            s = from[s];
        }
        middle.reverse();
        wrap(middle)
    } else if end.x >= start.x {
        let x = (start.x + end.x) / 2.;
        wrap(vec![Point { x, y: start.y }, Point { x, y: end.y }])
    } else {
        let y = (start.y + end.y) / 2.;
        wrap(vec![Point { x: start.x, y }, Point { x: end.x, y }])
    }
}
pub fn rounded_path(points: &[Point], radius: f64) -> String {
    if points.is_empty() {
        return String::new();
    }
    let mut s = format!("M {} {}", points[0].x, points[0].y);
    for w in points.windows(3) {
        let [prev, p, next] = [w[0], w[1], w[2]];
        let r = radius
            .min((p.x - prev.x).hypot(p.y - prev.y) / 2.)
            .min((next.x - p.x).hypot(next.y - p.y) / 2.);
        let toward = |o: Point| {
            let len = (o.x - p.x).hypot(o.y - p.y);
            let len = if len == 0. { 1. } else { len };
            Point {
                x: p.x + (o.x - p.x) / len * r,
                y: p.y + (o.y - p.y) / len * r,
            }
        };
        let a = toward(prev);
        let b = toward(next);
        s += &format!(" L {} {} Q {} {} {} {}", a.x, a.y, p.x, p.y, b.x, b.y);
    }
    let p = points.last().unwrap();
    s + &format!(" L {} {}", p.x, p.y)
}
pub fn midpoint(points: &[Point]) -> Point {
    let lengths: Vec<f64> = points
        .windows(2)
        .map(|w| (w[1].x - w[0].x).hypot(w[1].y - w[0].y))
        .collect();
    let mut left = lengths.iter().sum::<f64>() / 2.;
    for (i, &len) in lengths.iter().enumerate() {
        if left <= len {
            let a = points[i];
            let b = points[i + 1];
            let t = if len != 0. { left / len } else { 0. };
            return Point {
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
            };
        }
        left -= len;
    }
    points.first().copied().unwrap_or_default()
}
fn points(v: &Value) -> Result<Vec<Point>, String> {
    serde_json::from_value(v.clone()).map_err(|e| e.to_string())
}
pub fn route_json(a: &Value, b: &Value, c: &Value) -> Result<Value, String> {
    let a = serde_json::from_value(a.clone()).map_err(|e| e.to_string())?;
    let b = serde_json::from_value(b.clone()).map_err(|e| e.to_string())?;
    let c = serde_json::from_value::<Vec<Rect>>(c.clone()).map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(route(a, b, &c)).unwrap())
}
pub fn simplify_json(v: &Value) -> Result<Value, String> {
    Ok(serde_json::to_value(simplify(&points(v)?)).unwrap())
}
pub fn path_json(v: &Value, r: f64) -> Result<Value, String> {
    Ok(Value::String(rounded_path(&points(v)?, r)))
}
pub fn midpoint_json(v: &Value) -> Result<Value, String> {
    Ok(serde_json::to_value(midpoint(&points(v)?)).unwrap())
}
