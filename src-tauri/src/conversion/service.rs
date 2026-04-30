use std::{
    fs::{self, File},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
};

use image::{
    codecs::{ico::IcoEncoder, jpeg::JpegEncoder},
    imageops::FilterType,
    DynamicImage, ExtendedColorType, ImageEncoder, ImageFormat, ImageReader,
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::{
    conversion::naming::unique_output_path,
    dto::{
        ConvertBatchRequest, ConvertBatchResponse, ConvertFileResult, ConvertFileStatus,
        OutputFormat, ResizeMode, ResizeOptions,
    },
    errors::{AppError, AppResult},
    events::{ConversionProgressEvent, ConversionProgressStatus, CONVERSION_PROGRESS_EVENT},
};

pub struct ConversionService {
    app: AppHandle,
}

struct ConvertedFile {
    output_path: String,
    warnings: Vec<String>,
}

impl ConversionService {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    pub fn run(self, request: ConvertBatchRequest) -> AppResult<ConvertBatchResponse> {
        validate_request(&request)?;

        let job_id = Uuid::new_v4().to_string();
        let total = request.sources.len() as u32;
        let mut succeeded = 0_u32;
        let mut failed = 0_u32;
        let skipped = 0_u32;
        let mut results = Vec::with_capacity(request.sources.len());

        for (index, source_path) in request.sources.iter().enumerate() {
            self.emit_progress(ConversionProgressEvent {
                job_id: job_id.clone(),
                index: index as u32 + 1,
                total,
                source_path: Some(source_path.clone()),
                output_path: None,
                status: ConversionProgressStatus::Processing,
                message: None,
                succeeded,
                failed,
            })?;

            match self.convert_one(source_path, &request) {
                Ok(converted) => {
                    succeeded += 1;
                    self.emit_progress(ConversionProgressEvent {
                        job_id: job_id.clone(),
                        index: index as u32 + 1,
                        total,
                        source_path: Some(source_path.clone()),
                        output_path: Some(converted.output_path.clone()),
                        status: ConversionProgressStatus::Success,
                        message: None,
                        succeeded,
                        failed,
                    })?;

                    results.push(ConvertFileResult {
                        source_path: source_path.clone(),
                        output_path: Some(converted.output_path),
                        status: ConvertFileStatus::Success,
                        error_code: None,
                        error_message: None,
                        warnings: converted.warnings,
                    });
                }
                Err(error) => {
                    failed += 1;
                    let code = error.code().to_string();
                    let message = error.to_string();

                    self.emit_progress(ConversionProgressEvent {
                        job_id: job_id.clone(),
                        index: index as u32 + 1,
                        total,
                        source_path: Some(source_path.clone()),
                        output_path: None,
                        status: ConversionProgressStatus::Failed,
                        message: Some(message.clone()),
                        succeeded,
                        failed,
                    })?;

                    results.push(ConvertFileResult {
                        source_path: source_path.clone(),
                        output_path: None,
                        status: ConvertFileStatus::Failed,
                        error_code: Some(code),
                        error_message: Some(message),
                        warnings: Vec::new(),
                    });
                }
            }
        }

        self.emit_progress(ConversionProgressEvent {
            job_id: job_id.clone(),
            index: total,
            total,
            source_path: None,
            output_path: None,
            status: ConversionProgressStatus::Completed,
            message: None,
            succeeded,
            failed,
        })?;

        Ok(ConvertBatchResponse {
            job_id,
            total,
            succeeded,
            failed,
            skipped,
            results,
        })
    }

    fn convert_one(
        &self,
        source_path: &str,
        request: &ConvertBatchRequest,
    ) -> AppResult<ConvertedFile> {
        let source = PathBuf::from(source_path);
        if !source.is_file() {
            return Err(AppError::InvalidRequest(format!(
                "Source file does not exist: {source_path}"
            )));
        }

        let image = ImageReader::open(&source)?
            .with_guessed_format()?
            .decode()?;
        let transformed = transform_image(image, request)?;

        let output_dir = request
            .output_dir
            .as_ref()
            .map(PathBuf::from)
            .or_else(|| source.parent().map(Path::to_path_buf))
            .ok_or_else(|| {
                AppError::InvalidRequest("Unable to resolve output directory.".into())
            })?;

        fs::create_dir_all(&output_dir)?;
        let output_path = unique_output_path(&source, &output_dir, &request.target_format)?;
        let warnings = build_warnings(request);
        write_output(&transformed, &output_path, request)?;

        Ok(ConvertedFile {
            output_path: output_path.to_string_lossy().into_owned(),
            warnings,
        })
    }

    fn emit_progress(&self, event: ConversionProgressEvent) -> AppResult<()> {
        self.app
            .emit(CONVERSION_PROGRESS_EVENT, event)
            .map_err(|error| AppError::Internal(error.to_string()))
    }
}

fn validate_request(request: &ConvertBatchRequest) -> AppResult<()> {
    if request.sources.is_empty() {
        return Err(AppError::InvalidRequest(
            "Please provide at least one image.".into(),
        ));
    }

    if let Some(quality) = request.quality {
        if quality == 0 || quality > 100 {
            return Err(AppError::InvalidRequest(
                "Quality must be between 1 and 100.".into(),
            ));
        }
    }

    if let Some(size) = request.ico_size {
        if !matches!(size, 16 | 32 | 48 | 64 | 128 | 256) {
            return Err(AppError::InvalidRequest(
                "ICO size must be one of 16, 32, 48, 64, 128 or 256.".into(),
            ));
        }
    }

    if matches!(request.resize.width, Some(0)) || matches!(request.resize.height, Some(0)) {
        return Err(AppError::InvalidRequest(
            "Resize width and height must be greater than zero.".into(),
        ));
    }

    match request.resize.mode {
        ResizeMode::None => Ok(()),
        ResizeMode::Fit => {
            if request.resize.width.is_none() && request.resize.height.is_none() {
                return Err(AppError::InvalidRequest(
                    "Fit resize requires width or height.".into(),
                ));
            }
            Ok(())
        }
        ResizeMode::Exact => {
            if request.resize.width.is_none() || request.resize.height.is_none() {
                return Err(AppError::InvalidRequest(
                    "Exact resize requires both width and height.".into(),
                ));
            }
            Ok(())
        }
    }
}

fn build_warnings(request: &ConvertBatchRequest) -> Vec<String> {
    let mut warnings = Vec::new();

    if matches!(request.target_format, OutputFormat::Webp) && request.quality.is_some() {
        warnings.push("WebP currently uses lossless encoding with the image crate.".into());
    }

    if matches!(request.target_format, OutputFormat::Gif) {
        warnings.push("Animated GIF inputs are exported as single-frame images.".into());
    }

    warnings
}

fn transform_image(image: DynamicImage, request: &ConvertBatchRequest) -> AppResult<DynamicImage> {
    let resized = apply_resize(image, &request.resize)?;

    if matches!(request.target_format, OutputFormat::Ico) {
        let size = request.ico_size.unwrap_or(256);
        return Ok(resized.resize_exact(size, size, FilterType::Lanczos3));
    }

    Ok(resized)
}

fn apply_resize(image: DynamicImage, resize: &ResizeOptions) -> AppResult<DynamicImage> {
    let original_width = image.width();
    let original_height = image.height();

    match resize.mode {
        ResizeMode::None => Ok(image),
        ResizeMode::Fit => {
            let (target_width, target_height) = fit_dimensions(
                original_width,
                original_height,
                resize.width,
                resize.height,
                resize.allow_upscale,
            )?;

            if target_width == original_width && target_height == original_height {
                return Ok(image);
            }

            Ok(image.resize(target_width, target_height, FilterType::Lanczos3))
        }
        ResizeMode::Exact => {
            let mut target_width = resize.width.unwrap_or(original_width);
            let mut target_height = resize.height.unwrap_or(original_height);

            if !resize.allow_upscale {
                target_width = target_width.min(original_width);
                target_height = target_height.min(original_height);
            }

            if target_width == original_width && target_height == original_height {
                return Ok(image);
            }

            Ok(image.resize_exact(
                target_width.max(1),
                target_height.max(1),
                FilterType::Lanczos3,
            ))
        }
    }
}

fn fit_dimensions(
    original_width: u32,
    original_height: u32,
    width: Option<u32>,
    height: Option<u32>,
    allow_upscale: bool,
) -> AppResult<(u32, u32)> {
    let max_width = width.unwrap_or(original_width) as f64;
    let max_height = height.unwrap_or(original_height) as f64;
    let width_scale = width.map(|value| value as f64 / original_width as f64);
    let height_scale = height.map(|value| value as f64 / original_height as f64);

    let mut scale = match (width_scale, height_scale) {
        (Some(w), Some(h)) => w.min(h),
        (Some(w), None) => w,
        (None, Some(h)) => h,
        (None, None) => {
            return Err(AppError::InvalidRequest(
                "Fit resize requires width or height.".into(),
            ))
        }
    };

    if !allow_upscale {
        scale = scale.min(1.0);
    }

    let width = ((original_width as f64) * scale)
        .round()
        .clamp(1.0, max_width.max(1.0));
    let height = ((original_height as f64) * scale)
        .round()
        .clamp(1.0, max_height.max(1.0));

    Ok((width as u32, height as u32))
}

fn write_output(
    image: &DynamicImage,
    output_path: &Path,
    request: &ConvertBatchRequest,
) -> AppResult<()> {
    let file = File::create(output_path)?;
    let mut writer = BufWriter::new(file);

    match request.target_format {
        OutputFormat::Jpeg => {
            let rgb = image.to_rgb8();
            let quality = request.quality.unwrap_or(90).clamp(1, 100);
            JpegEncoder::new_with_quality(&mut writer, quality).write_image(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                ExtendedColorType::Rgb8,
            )?;
        }
        OutputFormat::Ico => {
            let rgba = image.to_rgba8();
            IcoEncoder::new(&mut writer).write_image(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                ExtendedColorType::Rgba8,
            )?;
        }
        OutputFormat::Png => image.write_to(&mut writer, ImageFormat::Png)?,
        OutputFormat::Webp => image.write_to(&mut writer, ImageFormat::WebP)?,
        OutputFormat::Bmp => image.write_to(&mut writer, ImageFormat::Bmp)?,
        OutputFormat::Gif => image.write_to(&mut writer, ImageFormat::Gif)?,
        OutputFormat::Tiff => image.write_to(&mut writer, ImageFormat::Tiff)?,
    }

    writer.flush()?;
    Ok(())
}
