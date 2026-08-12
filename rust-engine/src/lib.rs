/**
 * Discord 画像圧縮くん - Rust/WASM画像圧縮エンジン
 * 
 * 機能:
 * 1. compress_image_jpeg — JPEG品質指定圧縮
 * 2. compress_to_target_size — 目標サイズに自動圧縮（JPEG二分探索＋ダウンスケール）
 * 3. compress_webp_lossless — WebP可逆圧縮
 * 4. get_image_info — 画像情報を取得
 * 
 * 全処理がWASM内で完結（サーバー通信なし）
 */

use wasm_bindgen::prelude::*;
use image::{ImageFormat, ImageReader, DynamicImage, GenericImageView};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::webp::WebPEncoder;
use std::io::Cursor;

/// JavaScriptのconsole.log出力用マクロ
macro_rules! console_log {
    ($($t:tt)*) => {
        web_sys::console::log_1(&format!($($t)*).into());
    };
}

/// 画像情報
#[wasm_bindgen]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    pub file_size: u32,
    format_string: String,
}

#[wasm_bindgen]
impl ImageInfo {
    #[wasm_bindgen(getter)]
    pub fn format(&self) -> String {
        self.format_string.clone()
    }
}

/// 画像圧縮エンジン
#[wasm_bindgen]
pub struct ImageCompressor;

#[wasm_bindgen]
impl ImageCompressor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> ImageCompressor {
        ImageCompressor
    }

    /// 画像情報を取得
    #[wasm_bindgen]
    pub fn get_image_info(&self, data: &[u8]) -> ImageInfo {
        let format = detect_format(data);
        let file_size = data.len() as u32;

        match ImageReader::new(Cursor::new(data))
            .with_guessed_format()
            .ok()
            .and_then(|r| r.into_dimensions().ok())
        {
            Some((width, height)) => ImageInfo {
                width,
                height,
                file_size,
                format_string: format,
            },
            None => ImageInfo {
                width: 0,
                height: 0,
                file_size,
                format_string: "Unknown".to_string(),
            },
        }
    }

    /// JPEG品質指定で圧縮
    #[wasm_bindgen]
    pub fn compress_image_jpeg(
        &self,
        data: &[u8],
        quality: u8,
        max_width: u32,
        max_height: u32,
    ) -> Vec<u8> {
        console_log!("compress_image_jpeg: q={}, max_w={}, max_h={}", quality, max_width, max_height);

        let img = match image::load_from_memory(data) {
            Ok(img) => img,
            Err(e) => {
                console_log!("デコードエラー: {}", e);
                return Vec::new();
            }
        };

        let img = resize_if_needed(&img, max_width, max_height);
        encode_jpeg(&img, quality)
    }

    /// 目標サイズ以下に自動圧縮（二分探索＋段階的ダウンスケール）
    #[wasm_bindgen]
    pub fn compress_to_target_size(&self, data: &[u8], target_bytes: usize) -> Vec<u8> {
        console_log!("target: {} bytes ({:.2} MB)", target_bytes, target_bytes as f64 / (1024.0 * 1024.0));

        let img = match image::load_from_memory(data) {
            Ok(img) => img,
            Err(e) => {
                console_log!("デコードエラー: {}", e);
                return Vec::new();
            }
        };

        let (orig_w, orig_h) = img.dimensions();
        console_log!("元画像: {}x{} ({} bytes)", orig_w, orig_h, data.len());

        // ステップ1: フル解像度で二分探索
        let result = binary_search_quality(&img, target_bytes);
        if result.len() <= target_bytes && !result.is_empty() {
            console_log!("✅ フル解像度で目標達成! {} bytes", result.len());
            return result;
        }

        // ステップ2: 解像度を段階的に下げる
        console_log!("解像度を下げます...");
        let scales: [f32; 9] = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1];
        let mut best_result = result;

        for &scale in &scales {
            let new_w = ((orig_w as f32 * scale).round() as u32).max(32);
            let new_h = ((orig_h as f32 * scale).round() as u32).max(32);

            // リサイズ（DynamicImage::resize は DynamicImageを返す）
            let resized = img.resize_exact(new_w, new_h, image::imageops::FilterType::Lanczos3);
            let compressed = binary_search_quality(&resized, target_bytes);

            if !compressed.is_empty() && compressed.len() <= target_bytes {
                console_log!("✅ scale {} で達成! {}x{} → {} bytes", scale, new_w, new_h, compressed.len());
                return compressed;
            }

            if compressed.len() < best_result.len() {
                best_result = compressed;
            }
        }

        console_log!("⚠️ 目標未達。最良: {} bytes", best_result.len());
        best_result
    }

    /// WebP可逆圧縮（PNG代替用）
    #[wasm_bindgen]
    pub fn compress_webp_lossless(&self, data: &[u8]) -> Vec<u8> {
        let img = match image::load_from_memory(data) {
            Ok(img) => img,
            Err(e) => {
                console_log!("デコードエラー: {}", e);
                return Vec::new();
            }
        };
        encode_webp_lossless(&img)
    }
}

impl Default for ImageCompressor {
    fn default() -> Self {
        Self::new()
    }
}

// ============ ヘルパー関数 ============

fn detect_format(data: &[u8]) -> String {
    match image::guess_format(data) {
        Ok(ImageFormat::Jpeg) => "JPEG".to_string(),
        Ok(ImageFormat::Png) => "PNG".to_string(),
        Ok(ImageFormat::WebP) => "WebP".to_string(),
        Ok(ImageFormat::Gif) => "GIF".to_string(),
        Ok(ImageFormat::Bmp) => "BMP".to_string(),
        Ok(fmt) => format!("{:?}", fmt),
        Err(_) => "Unknown".to_string(),
    }
}

/// 最大サイズを超える場合にリサイズ（アスペクト比維持）
fn resize_if_needed(img: &DynamicImage, max_width: u32, max_height: u32) -> DynamicImage {
    let (w, h) = img.dimensions();

    let need_resize_w = max_width > 0 && w > max_width;
    let need_resize_h = max_height > 0 && h > max_height;

    if !need_resize_w && !need_resize_h {
        return img.clone();
    }

    let ratio_w = if max_width > 0 { max_width as f32 / w as f32 } else { 1.0 };
    let ratio_h = if max_height > 0 { max_height as f32 / h as f32 } else { 1.0 };
    let scale = ratio_w.min(ratio_h);

    let new_w = ((w as f32 * scale).round() as u32).max(1);
    let new_h = ((h as f32 * scale).round() as u32).max(1);

    console_log!("リサイズ: {}x{} → {}x{}", w, h, new_w, new_h);
    img.resize_exact(new_w, new_h, image::imageops::FilterType::Lanczos3)
}

/// 二分探索でJPEG品質を調整して目標サイズに寄せる
fn binary_search_quality(img: &DynamicImage, target_bytes: usize) -> Vec<u8> {
    let mut low: u8 = 1;
    let mut high: u8 = 100;
    let mut best_blob: Vec<u8> = Vec::new();

    for i in 0..20u32 {
        if low >= high { break; }
        let mid = (low + high) / 2;
        let blob = encode_jpeg(img, mid);

        console_log!("[探索 {}] q={}, {} bytes", i, mid, blob.len());

        if blob.len() <= target_bytes {
            best_blob = blob;
            low = mid + 1;
        } else {
            high = mid.saturating_sub(1);
        }
    }

    if best_blob.is_empty() {
        best_blob = encode_jpeg(img, 1);
    }

    best_blob
}

/// JPEGエンコード
fn encode_jpeg(img: &DynamicImage, quality: u8) -> Vec<u8> {
    let mut buf = Vec::new();
    let rgb = img.to_rgb8();
    let mut encoder = JpegEncoder::new_with_quality(&mut buf, quality);

    match encoder.encode(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8) {
        Ok(()) => buf,
        Err(e) => {
            console_log!("JPEGエンコードエラー: {}", e);
            Vec::new()
        }
    }
}

/// WebP losslessエンコード
fn encode_webp_lossless(img: &DynamicImage) -> Vec<u8> {
    let mut buf = Vec::new();
    let rgb = img.to_rgb8();
    let encoder = WebPEncoder::new_lossless(&mut buf);

    match encoder.encode(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8) {
        Ok(()) => buf,
        Err(e) => {
            console_log!("WebPエンコードエラー: {}", e);
            Vec::new()
        }
    }
}
