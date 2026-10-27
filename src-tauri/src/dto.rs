use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Png,
    Jpeg,
    Webp,
    Bmp,
    Gif,
    Tiff,
    Ico,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ResizeMode {
    None,
    Fit,
    Exact,
    Longest,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PngCompression {
    Fast,
    #[default]
    Balanced,
    Best,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WebpMode {
    #[default]
    Lossless,
    Lossy,
}

fn default_jpeg_background() -> String {
    "#ffffff".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeOptions {
    pub mode: ResizeMode,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub allow_upscale: bool,
    #[serde(default)]
    pub longest_edge: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertBatchRequest {
    pub sources: Vec<String>,
    pub target_format: OutputFormat,
    pub output_dir: Option<String>,
    pub quality: Option<u8>,
    pub resize: ResizeOptions,
    pub ico_size: Option<u32>,
    #[serde(default)]
    pub png_compression: PngCompression,
    #[serde(default)]
    pub webp_mode: WebpMode,
    #[serde(default = "default_jpeg_background")]
    pub jpeg_background: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConvertFileStatus {
    Success,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertFileResult {
    pub source_path: String,
    pub output_path: Option<String>,
    pub status: ConvertFileStatus,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertBatchResponse {
    pub job_id: String,
    pub total: u32,
    pub succeeded: u32,
    pub failed: u32,
    pub skipped: u32,
    pub results: Vec<ConvertFileResult>,
}
