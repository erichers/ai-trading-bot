//! API error type that mirrors FastAPI's HTTPException {detail} responses.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub detail: String,
}

impl ApiError {
    pub fn new(status: StatusCode, detail: impl Into<String>) -> Self {
        ApiError {
            status,
            detail: detail.into(),
        }
    }

    /// 503 — upstream (Alpaca/LLM) unavailable.
    pub fn upstream(detail: impl Into<String>) -> Self {
        ApiError::new(StatusCode::SERVICE_UNAVAILABLE, detail)
    }

    /// 424 — missing dependency / credentials.
    pub fn dependency(detail: impl Into<String>) -> Self {
        ApiError::new(StatusCode::FAILED_DEPENDENCY, detail)
    }

    pub fn not_found(detail: impl Into<String>) -> Self {
        ApiError::new(StatusCode::NOT_FOUND, detail)
    }

    pub fn bad_request(detail: impl Into<String>) -> Self {
        ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, detail)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "detail": self.detail }))).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, format!("db error: {e}"))
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
