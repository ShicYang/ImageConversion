use serde::Serialize;

pub const CONVERSION_PROGRESS_EVENT: &str = "conversion://progress";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConversionProgressStatus {
    Processing,
    Success,
    Failed,
    Completed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionProgressEvent {
    pub job_id: String,
    pub index: u32,
    pub total: u32,
    pub source_path: Option<String>,
    pub output_path: Option<String>,
    pub status: ConversionProgressStatus,
    pub message: Option<String>,
    pub succeeded: u32,
    pub failed: u32,
}
