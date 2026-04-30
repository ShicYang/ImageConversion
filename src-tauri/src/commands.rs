use tauri::async_runtime;

use crate::{
    conversion::service::ConversionService,
    dto::{ConvertBatchRequest, ConvertBatchResponse},
    errors::{ApiError, AppError},
};

#[tauri::command]
pub async fn convert_batch(
    app: tauri::AppHandle,
    request: ConvertBatchRequest,
) -> Result<ConvertBatchResponse, ApiError> {
    async_runtime::spawn_blocking(move || ConversionService::new(app).run(request))
        .await
        .map_err(|error| ApiError::from(AppError::Internal(error.to_string())))?
        .map_err(ApiError::from)
}
