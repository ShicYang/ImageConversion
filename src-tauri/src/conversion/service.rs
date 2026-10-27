use std::{
    fs::{self, File},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
};

use image::{
    codecs::{
        ico::IcoEncoder,
        jpeg::JpegEncoder,
        png::{CompressionType, FilterType as PngFilterType, PngEncoder},
    },
    imageops::FilterType,
    DynamicImage, ExtendedColorType, ImageEncoder, ImageFormat, ImageReader,
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::{
    conversion::naming::unique_output_path,
    dto::{
        ConvertBatchRequest, ConvertBatchResponse, ConvertFileResult, ConvertFileStatus,
        OutputFormat, PngCompression, ResizeMode, ResizeOptions, WebpMode,
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

    if matches!(request.target_format, OutputFormat::Jpeg) {
        parse_background(&request.jpeg_background)?;
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
        ResizeMode::Longest => {
            if request.resize.longest_edge.unwrap_or(0) == 0 {
                return Err(AppError::InvalidRequest(
                    "请填写大于零的最长边尺寸。".into(),
                ));
            }
            Ok(())
        }
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

    if matches!(request.target_format, OutputFormat::Gif) {
        warnings.push("Animated GIF inputs are exported as single-frame images.".into());
    }

    warnings
}

fn transform_image(image: DynamicImage, request: &ConvertBatchRequest) -> AppResult<DynamicImage> {
    if matches!(request.target_format, OutputFormat::Ico) {
        let size = request.ico_size.unwrap_or(256);
        let scaled = image.resize(size, size, FilterType::Lanczos3).to_rgba8();
        let mut canvas = image::RgbaImage::new(size, size);
        image::imageops::overlay(
            &mut canvas,
            &scaled,
            ((size - scaled.width()) / 2) as i64,
            ((size - scaled.height()) / 2) as i64,
        );
        return Ok(DynamicImage::ImageRgba8(canvas));
    }

    apply_resize(image, &request.resize)
}

fn apply_resize(image: DynamicImage, resize: &ResizeOptions) -> AppResult<DynamicImage> {
    let original_width = image.width();
    let original_height = image.height();

    match resize.mode {
        ResizeMode::None => Ok(image),
        ResizeMode::Longest => {
            let edge = resize
                .longest_edge
                .filter(|edge| *edge > 0)
                .ok_or_else(|| AppError::InvalidRequest("请填写大于零的最长边尺寸。".into()))?;
            if !resize.allow_upscale && original_width.max(original_height) <= edge {
                return Ok(image);
            }
            Ok(image.resize(edge, edge, FilterType::Lanczos3))
        }
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

    let width = ((original_width as f64) * scale).round().max(1.0);
    let height = ((original_height as f64) * scale).round().max(1.0);

    Ok((width as u32, height as u32))
}

fn parse_background(value: &str) -> AppResult<[u8; 3]> {
    let hex = value.strip_prefix('#').unwrap_or("");
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::InvalidRequest(
            "JPEG 背景色须为 #RRGGBB 格式。".into(),
        ));
    }
    Ok([
        u8::from_str_radix(&hex[0..2], 16).unwrap(),
        u8::from_str_radix(&hex[2..4], 16).unwrap(),
        u8::from_str_radix(&hex[4..6], 16).unwrap(),
    ])
}

fn flatten_background(image: &DynamicImage, background: [u8; 3]) -> image::RgbImage {
    let rgba = image.to_rgba8();
    image::RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let pixel = rgba.get_pixel(x, y).0;
        let alpha = pixel[3] as u32;
        image::Rgb(std::array::from_fn(|channel| {
            ((pixel[channel] as u32 * alpha + background[channel] as u32 * (255 - alpha) + 127)
                / 255) as u8
        }))
    })
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
            let rgb = flatten_background(image, parse_background(&request.jpeg_background)?);
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
        OutputFormat::Png => {
            let compression = match request.png_compression {
                PngCompression::Fast => CompressionType::Fast,
                PngCompression::Balanced => CompressionType::Default,
                PngCompression::Best => CompressionType::Best,
            };
            PngEncoder::new_with_quality(&mut writer, compression, PngFilterType::Adaptive)
                .write_image(
                    image.as_bytes(),
                    image.width(),
                    image.height(),
                    image.color().into(),
                )?;
        }
        OutputFormat::Webp => {
            if matches!(request.webp_mode, WebpMode::Lossy) {
                let rgba = image.to_rgba8();
                let encoded = webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height())
                    .encode_simple(false, request.quality.unwrap_or(90) as f32)
                    .map_err(|error| AppError::Internal(format!("WebP 编码失败：{error:?}")))?;
                writer.write_all(&encoded)?;
            } else {
                image.write_to(&mut writer, ImageFormat::WebP)?;
            }
        }
        OutputFormat::Bmp => image.write_to(&mut writer, ImageFormat::Bmp)?,
        OutputFormat::Gif => image.write_to(&mut writer, ImageFormat::Gif)?,
        OutputFormat::Tiff => image.write_to(&mut writer, ImageFormat::Tiff)?,
    }

    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, Rgba, RgbaImage};

    fn request(format: OutputFormat) -> ConvertBatchRequest {
        ConvertBatchRequest {
            sources: vec!["example.png".into()],
            target_format: format,
            output_dir: None,
            quality: Some(90),
            resize: ResizeOptions {
                mode: ResizeMode::None,
                width: None,
                height: None,
                allow_upscale: false,
                longest_edge: Some(100),
            },
            ico_size: Some(64),
            png_compression: PngCompression::Balanced,
            webp_mode: WebpMode::Lossless,
            jpeg_background: "#ffffff".into(),
        }
    }

    fn sample() -> DynamicImage {
        DynamicImage::ImageRgba8(RgbaImage::from_fn(64, 48, |x, y| {
            Rgba([
                (x * 17 + y * 7) as u8,
                (y * 23 + x * 3) as u8,
                (x * y) as u8,
                if x < 8 { 0 } else { 192 },
            ])
        }))
    }

    fn encode(image: &DynamicImage, request: &ConvertBatchRequest) -> Vec<u8> {
        let path = std::env::temp_dir().join(format!("image-conversion-test-{}", Uuid::new_v4()));
        let result = write_output(image, &path, request).and_then(|()| Ok(fs::read(&path)?));
        let _ = fs::remove_file(path);
        result.unwrap()
    }

    #[test]
    fn png_compression_preserves_rgba_pixels_in_every_mode() {
        let source = sample();
        let mut options = request(OutputFormat::Png);
        for compression in [
            PngCompression::Fast,
            PngCompression::Balanced,
            PngCompression::Best,
        ] {
            options.png_compression = compression;
            let decoded = image::load_from_memory(&encode(&source, &options)).unwrap();
            assert_eq!(decoded.to_rgba8(), source.to_rgba8());
        }
    }

    #[test]
    fn webp_modes_and_quality_control_real_output() {
        let source = sample();
        let mut options = request(OutputFormat::Webp);
        let lossless = encode(&source, &options);
        let decoded = image::load_from_memory(&lossless).unwrap().to_rgba8();
        // Fully transparent RGB is not visually meaningful and can be normalized by WebP.
        for (actual, expected) in decoded.pixels().zip(source.to_rgba8().pixels()) {
            assert_eq!(actual[3], expected[3]);
            if expected[3] > 0 {
                assert_eq!(actual, expected);
            }
        }
        options.webp_mode = WebpMode::Lossy;
        options.quality = Some(15);
        let low = encode(&source, &options);
        options.quality = Some(95);
        let high = encode(&source, &options);
        assert_ne!(low, high);
        assert!(low.len() < high.len());
        for bytes in [low, high] {
            let decoded = image::load_from_memory(&bytes).unwrap().to_rgba8();
            assert_eq!(decoded.dimensions(), (64, 48));
            assert_eq!(decoded.get_pixel(16, 16)[3], 192);
            assert_eq!(decoded.get_pixel(0, 0)[3], 0);
        }
    }

    #[test]
    fn jpeg_composites_transparent_and_partial_alpha() {
        let source = DynamicImage::ImageRgba8(RgbaImage::from_fn(3, 1, |x, _| {
            Rgba([255, 0, 0, [0, 128, 255][x as usize]])
        }));
        let flat = flatten_background(&source, [255, 255, 255]);
        assert_eq!(flat.get_pixel(0, 0).0, [255, 255, 255]);
        assert_eq!(flat.get_pixel(1, 0).0, [255, 127, 127]);
        assert_eq!(flat.get_pixel(2, 0).0, [255, 0, 0]);
        assert_eq!(
            flatten_background(&source, [0, 0, 255]).get_pixel(0, 0).0,
            [0, 0, 255]
        );
        let solid = DynamicImage::ImageRgba8(RgbaImage::from_pixel(16, 16, Rgba([255, 0, 0, 0])));
        let mut options = request(OutputFormat::Jpeg);
        options.jpeg_background = "#00ff00".into();
        let decoded = image::load_from_memory(&encode(&solid, &options))
            .unwrap()
            .to_rgb8();
        let pixel = decoded.get_pixel(8, 8);
        assert!(pixel[0] < 5 && pixel[1] > 250 && pixel[2] < 5);
    }

    #[test]
    fn longest_edge_handles_orientation_and_upscale() {
        let mut options = request(OutputFormat::Png).resize;
        options.mode = ResizeMode::Longest;
        for (width, height, expected) in [
            (400, 200, (100, 50)),
            (200, 400, (50, 100)),
            (20, 10, (20, 10)),
        ] {
            let source = DynamicImage::new_rgba8(width, height);
            assert_eq!(
                apply_resize(source, &options).unwrap().dimensions(),
                expected
            );
        }
        options.allow_upscale = true;
        assert_eq!(
            apply_resize(DynamicImage::new_rgba8(20, 10), &options)
                .unwrap()
                .dimensions(),
            (100, 50)
        );
        // A single supplied dimension must not clamp the unspecified side during enlargement.
        assert_eq!(
            fit_dimensions(20, 10, Some(100), None, true).unwrap(),
            (100, 50)
        );
        assert_eq!(
            fit_dimensions(10, 20, None, Some(100), true).unwrap(),
            (50, 100)
        );
    }

    #[test]
    fn ico_preserves_aspect_ratio_with_transparent_padding() {
        let source =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(80, 40, Rgba([255, 0, 0, 255])));
        let options = request(OutputFormat::Ico);
        let output = transform_image(source, &options).unwrap();
        let decoded = image::load_from_memory(&encode(&output, &options)).unwrap();
        assert_eq!(decoded.dimensions(), (64, 64));
        assert_eq!(decoded.get_pixel(32, 0)[3], 0);
        assert_eq!(decoded.get_pixel(32, 32).0, [255, 0, 0, 255]);
    }

    #[test]
    fn validates_background_and_longest_edge_and_accepts_legacy_requests() {
        assert_eq!(parse_background("#fF8040").unwrap(), [255, 128, 64]);
        for color in ["white", "#fff", "#gg0000", "#中文"] {
            assert!(parse_background(color).is_err());
        }
        let mut options = request(OutputFormat::Jpeg);
        options.jpeg_background = "invalid".into();
        assert!(validate_request(&options).is_err());
        options = request(OutputFormat::Png);
        options.resize.mode = ResizeMode::Longest;
        options.resize.longest_edge = Some(0);
        assert!(validate_request(&options).is_err());
        options.resize.longest_edge = None;
        assert!(validate_request(&options).is_err());
        let legacy: ConvertBatchRequest = serde_json::from_value(serde_json::json!({
            "sources": ["example.png"], "targetFormat": "png", "outputDir": null,
            "quality": null, "resize": { "mode": "none", "width": null, "height": null, "allowUpscale": false }, "icoSize": null
        })).unwrap();
        assert_eq!(legacy.png_compression, PngCompression::Balanced);
        assert_eq!(legacy.webp_mode, WebpMode::Lossless);
        assert_eq!(legacy.jpeg_background, "#ffffff");
    }
}
