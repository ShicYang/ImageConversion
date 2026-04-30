use std::path::{Path, PathBuf};

use crate::{
    dto::OutputFormat,
    errors::{AppError, AppResult},
};

pub fn extension_for_format(format: &OutputFormat) -> &'static str {
    match format {
        OutputFormat::Png => "png",
        OutputFormat::Jpeg => "jpg",
        OutputFormat::Webp => "webp",
        OutputFormat::Bmp => "bmp",
        OutputFormat::Gif => "gif",
        OutputFormat::Tiff => "tiff",
        OutputFormat::Ico => "ico",
    }
}

pub fn unique_output_path(
    source: &Path,
    output_dir: &Path,
    format: &OutputFormat,
) -> AppResult<PathBuf> {
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::InvalidRequest("Source file name is invalid.".into()))?;

    let extension = extension_for_format(format);
    let base_name = format!("{stem}");
    let mut candidate = output_dir.join(format!("{base_name}.{extension}"));

    if candidate != source && !candidate.exists() {
        return Ok(candidate);
    }

    for index in 2..10_000 {
        candidate = output_dir.join(format!("{base_name} ({index}).{extension}"));
        if candidate != source && !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(AppError::Internal(
        "Unable to generate a unique output file name.".into(),
    ))
}
