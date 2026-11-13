use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
#[derive(Debug)]
pub struct Error {
    pub status: u16,
    pub message: String,
}
impl Error {
    pub fn new(status: u16, s: impl Into<String>) -> Self {
        Self {
            status,
            message: s.into(),
        }
    }
}
impl From<String> for Error {
    fn from(s: String) -> Self {
        Self::new(400, s)
    }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::new(
            if e.kind() == std::io::ErrorKind::NotFound {
                404
            } else {
                503
            },
            "요청을 처리할 수 없습니다.",
        )
    }
}
impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self::new(400, "JSON 형식이 올바르지 않습니다.")
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (
            StatusCode::from_u16(self.status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE),
            Json(json!({"error":self.message})),
        )
            .into_response()
    }
}
pub type Result<T> = std::result::Result<T, Error>;
