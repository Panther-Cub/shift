use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{fs, fs::File, io::Read};
use std::sync::atomic::{AtomicUsize, Ordering};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use serde::Deserialize;
use tauri::{Emitter, Listener, Manager};
use image::{imageops, Rgba, RgbaImage};
use time::{format_description, OffsetDateTime};

#[tauri::command]
async fn convert_webp_to_mp4(
    input_path: String,
    job_id: String,
    options: ConvertOptions,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        convert_webp_to_mp4_sync(input_path, job_id, options, app_handle)
    })
    .await
    .map_err(|e| format!("Conversion task failed: {}", e))?
}

fn convert_webp_to_mp4_sync(
    input_path: String,
    job_id: String,
    options: ConvertOptions,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    
    if !input.exists() {
        return Err("Input file does not exist".to_string());
    }

    emit_progress(&app, &job_id, 0, "starting");

    let settings = ConversionSettings::from_options(&options)?;

    // Create output path (same directory or target directory, template-driven name)
    let input_stem = input
        .file_stem()
        .ok_or_else(|| "Invalid input file name".to_string())?
        .to_string_lossy()
        .to_string();
    let output_ext = settings.output_format.as_str();
    let output_stem = render_output_name(
        &settings.output_name_template,
        &input_stem,
        settings.sequence,
        output_ext,
    );
    let output = match &settings.output_dir {
        Some(dir) => {
            let mut out_dir = PathBuf::from(dir);
            fs::create_dir_all(&out_dir)
                .map_err(|e| format!("Failed to create output directory: {}", e))?;
            out_dir.push(&output_stem);
            out_dir.set_extension(output_ext);
            out_dir
        }
        None => {
            let mut out = input.with_file_name(&output_stem);
            out.set_extension(output_ext);
            out
        }
    };
    let output = ensure_unique_path(output);
    let output_str = output.to_string_lossy().to_string();

    // Get the bundled FFmpeg path
    let ffmpeg_path = match get_ffmpeg_path(&app) {
        Ok(path) => path,
        Err(err) => {
            let msg = format!("Failed to locate ffmpeg: {}", err);
            let _ = write_debug_log(&app, &build_debug_report(&input_path, None, None, None, &msg));
            return Err(msg);
        }
    };

    let is_animated = is_animated_webp(&input).map_err(|e| e.to_string())?;

    if let Err(err) = run_ffmpeg_conversion(
        &ffmpeg_path,
        &input_path,
        &output_str,
        is_animated,
        &settings,
    ) {
        let webpmux_path = resolve_webp_tool_path(&app, "webpmux");
        let dwebp_path = resolve_webp_tool_path(&app, "dwebp");
        if let Err(fallback_err) = fallback_convert_with_webpmux(
            &app,
            &job_id,
            &ffmpeg_path,
            webpmux_path.as_ref().map_err(|e| e.clone())?,
            dwebp_path.as_ref().map_err(|e| e.clone())?,
            &input_path,
            &output,
            &settings,
        )
        {
            let combined = format!("{}\n{}", err, fallback_err);
            let log_path = write_debug_log(
                &app,
                &build_debug_report(
                    &input_path,
                    Some(&ffmpeg_path),
                    webpmux_path.as_ref().ok(),
                    dwebp_path.as_ref().ok(),
                    &combined,
                ),
            );
            let msg = match log_path {
                Some(path) => format!("Conversion failed. Log: {}", path.display()),
                None => "Conversion failed. Log unavailable.".to_string(),
            };
            return Err(format!("{}\n{}", msg, combined));
        }
    }

    emit_progress(&app, &job_id, 100, "done");
    Ok(output_str)
}

fn run_ffmpeg_conversion(
    ffmpeg_path: &PathBuf,
    input_path: &str,
    output_path: &str,
    is_animated: bool,
    settings: &ConversionSettings,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg_path);
    cmd.args(["-hide_banner", "-loglevel", "error"]);

    if !is_animated {
        // Static WebP -> short video clip.
        let fps = settings.fps.unwrap_or(30);
        cmd.args([
            "-loop",
            "1",
            "-t",
            &settings.static_duration.to_string(),
            "-r",
            &fps.to_string(),
        ]);
    } else if let Some(fps) = settings.fps {
        cmd.args(["-r", &fps.to_string()]);
    }

    let vf = build_ffmpeg_filter(settings);

    let output = cmd
        .args([
            "-i",
            input_path,
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-profile:v",
            "high",
            "-level",
            "4.1",
            "-vf",
            &vf,
            "-tune",
            "animation",
            "-preset",
            &settings.preset,
            "-crf",
            &settings.crf.to_string(),
            "-movflags",
            "+faststart",
            "-y",
            output_path,
        ])
        .output()
        .map_err(|e| format!("Failed to execute FFmpeg: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = if stderr.trim().is_empty() {
            "FFmpeg conversion failed".to_string()
        } else {
            format!("FFmpeg conversion failed: {}", stderr.trim())
        };
        return Err(msg);
    }

    Ok(())
}

fn is_animated_webp(path: &PathBuf) -> Result<bool, Box<dyn std::error::Error>> {
    let mut file = File::open(path)?;
    let mut buf = [0u8; 8192];
    let mut carry = Vec::new();

    loop {
        let read = file.read(&mut buf)?;
        if read == 0 {
            break;
        }

        let mut window = carry.clone();
        window.extend_from_slice(&buf[..read]);

        if window.windows(4).any(|w| w == b"ANIM" || w == b"ANMF") {
            return Ok(true);
        }

        carry = window[window.len().saturating_sub(3)..].to_vec();
    }

    Ok(false)
}

fn fallback_convert_with_webpmux(
    app: &tauri::AppHandle,
    job_id: &str,
    ffmpeg_path: &PathBuf,
    webpmux_path: &PathBuf,
    dwebp_path: &PathBuf,
    input_path: &str,
    output_path: &PathBuf,
    settings: &ConversionSettings,
) -> Result<(), String> {
    let temp_dir = create_temp_dir().map_err(|e| format!("Failed to create temp dir: {}", e))?;
    let info_output = Command::new(webpmux_path)
        .args(["-info", input_path])
        .output()
        .map_err(|e| format!("Failed to execute webpmux: {}", e))?;

    if !info_output.status.success() {
        let stderr = String::from_utf8_lossy(&info_output.stderr);
        return Err(format!("webpmux -info failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&info_output.stdout);
    let stderr = String::from_utf8_lossy(&info_output.stderr);
    let info_text = format!("{}\n{}", stdout, stderr);
    let (canvas_w, canvas_h, frames) = parse_webpmux_info(&info_text)?;
    let target_w = if canvas_w % 2 == 0 { canvas_w } else { canvas_w + 1 };
    let target_h = if canvas_h % 2 == 0 { canvas_h } else { canvas_h + 1 };
    let vf = format!("scale={}:{}", target_w, target_h);

    let bg = settings.background_rgba();
    let mut canvas = RgbaImage::from_pixel(canvas_w as u32, canvas_h as u32, bg);
    let mut frame_paths = Vec::new();

    for (index, frame) in frames.iter().enumerate() {
        let frame_index = index + 1;
        let frame_webp = temp_dir.join(format!("frame_{:04}.webp", frame_index));
        let frame_png = temp_dir.join(format!("frame_{:04}.png", frame_index));
        let composed_png = temp_dir.join(format!("composed_{:04}.png", frame_index));

        let output = Command::new(webpmux_path)
            .args([
                "-get",
                "frame",
                &frame_index.to_string(),
                input_path,
                "-o",
                frame_webp
                    .to_str()
                    .ok_or_else(|| "Invalid frame path".to_string())?,
            ])
            .output()
            .map_err(|e| format!("Failed to extract frame {}: {}", frame_index, e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "webpmux failed extracting frame {}: {}",
                frame_index,
                stderr.trim()
            ));
        }

        let output = Command::new(dwebp_path)
            .args([
                frame_webp
                    .to_str()
                    .ok_or_else(|| "Invalid frame path".to_string())?,
                "-o",
                frame_png
                    .to_str()
                    .ok_or_else(|| "Invalid frame path".to_string())?,
            ])
            .output()
            .map_err(|e| format!("Failed to decode frame {}: {}", frame_index, e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "dwebp failed decoding frame {}: {}",
                frame_index,
                stderr.trim()
            ));
        }

        let frame_img = image::open(&frame_png)
            .map_err(|e| format!("Failed to read frame {}: {}", frame_index, e))?
            .to_rgba8();
        composite_frame(
            &mut canvas,
            &frame_img,
            frame.offset_x,
            frame.offset_y,
            frame.blend,
        );

        canvas
            .save(&composed_png)
            .map_err(|e| format!("Failed to write composed frame {}: {}", frame_index, e))?;
        let duration_ms = if frames.len() == 1 {
            (settings.static_duration * 1000.0) as u64
        } else {
            frame.duration_ms
        };
        frame_paths.push((composed_png, duration_ms));

        if frame.dispose_background {
            clear_rect(
                &mut canvas,
                frame.offset_x,
                frame.offset_y,
                frame_img.width() as usize,
                frame_img.height() as usize,
            );
        }

        let progress = ((frame_index as f64 / frames.len() as f64) * 80.0).round() as u8;
        emit_progress(app, job_id, progress, "compositing");
    }

    let concat_str = if settings.fps.is_none() {
        let concat_path = temp_dir.join("concat.txt");
        let concat_content = build_concat_list(&frame_paths)?;
        fs::write(&concat_path, concat_content)
            .map_err(|e| format!("Failed to write concat file: {}", e))?;
        concat_path
            .to_str()
            .ok_or_else(|| "Invalid concat path".to_string())?
            .to_string()
    } else {
        String::new()
    };

    let output_str = output_path
        .to_str()
        .ok_or_else(|| "Invalid output path".to_string())?;

    let mut cmd = Command::new(ffmpeg_path);
    cmd.args(["-hide_banner", "-loglevel", "error"]);
    if let Some(fps) = settings.fps {
        if frame_paths.len() == 1 {
            let single_path = frame_paths
                .first()
                .and_then(|(path, _)| path.to_str())
                .ok_or_else(|| "Invalid frame path".to_string())?;
            cmd.args([
                "-loop",
                "1",
                "-t",
                &settings.static_duration.to_string(),
                "-i",
                single_path,
            ]);
        } else {
            let input_pattern = temp_dir.join("composed_%04d.png");
            cmd.args([
                "-framerate",
                &fps.to_string(),
                "-i",
                input_pattern
                    .to_str()
                    .ok_or_else(|| "Invalid input pattern".to_string())?,
            ]);
        }
    } else {
        cmd.args(["-f", "concat", "-safe", "0", "-i", &concat_str]);
    }

    let output = cmd
        .args([
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-profile:v",
            "high",
            "-level",
            "4.1",
            "-vf",
            &vf,
            "-vsync",
            if settings.fps.is_some() { "cfr" } else { "vfr" },
            "-tune",
            "animation",
            "-preset",
            &settings.preset,
            "-crf",
            &settings.crf.to_string(),
            "-movflags",
            "+faststart",
            "-y",
            output_str,
        ])
        .output()
        .map_err(|e| format!("Failed to execute FFmpeg: {}", e))?;

    let _ = fs::remove_dir_all(&temp_dir);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Fallback FFmpeg failed: {}", stderr.trim()));
    }

    emit_progress(app, job_id, 95, "encoding");

    Ok(())
}

fn parse_webpmux_info(output: &str) -> Result<(usize, usize, Vec<FrameInfo>), String> {
    let mut canvas = None;
    let mut frames: Vec<FrameInfo> = Vec::new();
    let mut in_table = false;

    for line in output.lines() {
        let lower = line.to_lowercase();
        if lower.contains("canvas") && lower.contains('x') {
            if let Some((w, h)) = parse_dimensions_from_line(line) {
                canvas = Some((w, h));
            }
        }

        if lower.starts_with("no.:") {
            in_table = true;
            continue;
        }

        if in_table {
            if let Some(frame) = parse_table_frame(line) {
                frames.push(frame);
            }
            continue;
        }
    }

    if frames.is_empty() {
        let mut current: Option<FrameInfo> = None;
        for line in output.lines() {
            let lower = line.to_lowercase();
            if is_frame_header(&lower) {
                if let Some(frame) = current.take() {
                    frames.push(frame);
                }
                current = Some(FrameInfo::default());
            } else if lower.contains("offset") {
                let nums = extract_numbers(line);
                if nums.len() >= 2 {
                    if let Some(frame) = current.as_mut() {
                        frame.offset_x = nums[0];
                        frame.offset_y = nums[1];
                    }
                }
            } else if lower.contains("duration") {
                let nums = extract_numbers(line);
                if let Some(ms) = nums.first().copied() {
                    if let Some(frame) = current.as_mut() {
                        frame.duration_ms = ms as u64;
                    }
                }
            } else if lower.contains("dispose") {
                let dispose_bg = lower.contains("background") || lower.contains("1");
                if let Some(frame) = current.as_mut() {
                    frame.dispose_background = dispose_bg;
                }
            } else if lower.contains("blend") {
                let blend = lower.contains("yes") || lower.contains("true") || lower.contains("1");
                if let Some(frame) = current.as_mut() {
                    frame.blend = blend;
                }
            }
        }

        if let Some(frame) = current.take() {
            frames.push(frame);
        }
    }

    let (canvas_w, canvas_h) =
        canvas.ok_or_else(|| "webpmux did not report a canvas size".to_string())?;
    if frames.is_empty() {
        let preview = output.lines().take(25).collect::<Vec<_>>().join("\n");
        return Err(format!(
            "webpmux did not report any frames. Output preview:\n{}",
            preview
        ));
    }

    Ok((canvas_w, canvas_h, frames))
}

fn is_frame_header(lower: &str) -> bool {
    if !lower.starts_with("frame") {
        return false;
    }
    let rest = lower.trim_start_matches("frame").trim_start();
    rest.starts_with('#') || rest.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
}

fn parse_dimensions_from_line(line: &str) -> Option<(usize, usize)> {
    let parts: Vec<&str> = line.split('x').collect();
    if parts.len() < 2 {
        return None;
    }
    let left = extract_numbers(parts[0]).first().copied()?;
    let right = extract_numbers(parts[1]).first().copied()?;
    Some((left, right))
}

fn extract_numbers(line: &str) -> Vec<usize> {
    let mut numbers = Vec::new();
    let mut current = String::new();
    for ch in line.chars() {
        if ch.is_ascii_digit() {
            current.push(ch);
        } else if !current.is_empty() {
            if let Ok(value) = current.parse::<usize>() {
                numbers.push(value);
            }
            current.clear();
        }
    }
    if !current.is_empty() {
        if let Ok(value) = current.parse::<usize>() {
            numbers.push(value);
        }
    }
    numbers
}

fn parse_table_frame(line: &str) -> Option<FrameInfo> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.is_empty() {
        return None;
    }
    if let Some(first) = parts.first() {
        if first.ends_with(':') {
            parts.remove(0);
        } else if first.chars().all(|c| c.is_ascii_digit()) && parts.get(1) == Some(&":") {
            parts.remove(0);
            parts.remove(0);
        }
    }
    if parts.len() < 8 {
        return None;
    }

    let width = parts[0].parse::<usize>().ok()?;
    let height = parts[1].parse::<usize>().ok()?;
    let offset_x = parts[3].parse::<usize>().ok()?;
    let offset_y = parts[4].parse::<usize>().ok()?;
    let duration_ms = parts[5].parse::<u64>().ok()?;
    let dispose_background = parts[6].eq_ignore_ascii_case("background");
    let blend = parts[7].eq_ignore_ascii_case("yes");

    let mut frame = FrameInfo::default();
    frame.offset_x = offset_x;
    frame.offset_y = offset_y;
    frame.duration_ms = duration_ms;
    frame.dispose_background = dispose_background;
    frame.blend = blend;
    if width == 0 || height == 0 {
        return None;
    }
    Some(frame)
}

fn build_concat_list(frame_paths: &[(PathBuf, u64)]) -> Result<String, String> {
    let mut lines = Vec::new();
    for (path, duration_ms) in frame_paths.iter() {
        let path_str = path
            .to_str()
            .ok_or_else(|| "Invalid frame path".to_string())?;
        let escaped = escape_concat_path(path_str);
        lines.push(format!("file '{}'", escaped));
        if *duration_ms > 0 {
            let duration = (*duration_ms as f64) / 1000.0;
            lines.push(format!("duration {:.6}", duration));
        }
    }
    if let Some((path, _)) = frame_paths.last() {
        let path_str = path
            .to_str()
            .ok_or_else(|| "Invalid frame path".to_string())?;
        let escaped = escape_concat_path(path_str);
        lines.push(format!("file '{}'", escaped));
    }
    Ok(lines.join("\n"))
}

fn escape_concat_path(path: &str) -> String {
    path.replace('\'', r"'\''")
}

fn composite_frame(
    canvas: &mut RgbaImage,
    frame: &RgbaImage,
    offset_x: usize,
    offset_y: usize,
    blend: bool,
) {
    if blend {
        imageops::overlay(canvas, frame, offset_x as i64, offset_y as i64);
        return;
    }

    let max_x = canvas.width() as usize;
    let max_y = canvas.height() as usize;
    let frame_w = frame.width() as usize;
    let frame_h = frame.height() as usize;

    for y in 0..frame_h {
        let dst_y = offset_y + y;
        if dst_y >= max_y {
            continue;
        }
        for x in 0..frame_w {
            let dst_x = offset_x + x;
            if dst_x >= max_x {
                continue;
            }
            let pixel = frame.get_pixel(x as u32, y as u32);
            canvas.put_pixel(dst_x as u32, dst_y as u32, *pixel);
        }
    }
}

fn clear_rect(canvas: &mut RgbaImage, x: usize, y: usize, w: usize, h: usize) {
    let max_x = canvas.width() as usize;
    let max_y = canvas.height() as usize;
    let clear = Rgba([0, 0, 0, 0]);
    for row in 0..h {
        let dst_y = y + row;
        if dst_y >= max_y {
            continue;
        }
        for col in 0..w {
            let dst_x = x + col;
            if dst_x >= max_x {
                continue;
            }
            canvas.put_pixel(dst_x as u32, dst_y as u32, clear);
        }
    }
}

#[derive(Debug, Clone)]
struct FrameInfo {
    offset_x: usize,
    offset_y: usize,
    duration_ms: u64,
    dispose_background: bool,
    blend: bool,
}

impl Default for FrameInfo {
    fn default() -> Self {
        Self {
            offset_x: 0,
            offset_y: 0,
            duration_ms: 33,
            dispose_background: false,
            blend: true,
        }
    }
}

fn resolve_webp_tool_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    if let Ok(resource_path) = app.path().resource_dir() {
        let bundled = resource_path
            .join("resources")
            .join("webp")
            .join(name);
        if bundled.exists() {
            ensure_executable(&bundled)?;
            return Ok(bundled);
        }

        let bundled_legacy = resource_path
            .join("resources")
            .join("webp")
            .join("bin")
            .join(name);
        if bundled_legacy.exists() {
            ensure_executable(&bundled_legacy)?;
            return Ok(bundled_legacy);
        }

        let legacy = resource_path.join("webp").join("bin").join(name);
        if legacy.exists() {
            ensure_executable(&legacy)?;
            return Ok(legacy);
        }
    }

    let dev_path = PathBuf::from("src-tauri/resources/webp").join(name);
    if dev_path.exists() {
        ensure_executable(&dev_path)?;
        return Ok(dev_path);
    }

    let dev_legacy = PathBuf::from("src-tauri/resources/webp/bin").join(name);
    if dev_legacy.exists() {
        ensure_executable(&dev_legacy)?;
        return Ok(dev_legacy);
    }

    let system_path = PathBuf::from(name);
    ensure_executable(&system_path)?;
    Ok(system_path)
}

fn create_temp_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let mut path = std::env::temp_dir();
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    path.push(format!("webpconv-{}-{}", stamp, count));
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn get_ffmpeg_path(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    // Try to get bundled FFmpeg first
    if let Ok(resource_path) = app.path().resource_dir() {
        let bundled_ffmpeg = resource_path
            .join("resources")
            .join("ffmpeg")
            .join("ffmpeg");
        if bundled_ffmpeg.exists() {
            ensure_executable(&bundled_ffmpeg)?;
            return Ok(bundled_ffmpeg);
        }

        let legacy_ffmpeg = resource_path.join("ffmpeg").join("ffmpeg");
        if legacy_ffmpeg.exists() {
            ensure_executable(&legacy_ffmpeg)?;
            return Ok(legacy_ffmpeg);
        }
    }
    
    // Fallback to dev environment
    let dev_ffmpeg = PathBuf::from("src-tauri/resources/ffmpeg/ffmpeg");
    if dev_ffmpeg.exists() {
        ensure_executable(&dev_ffmpeg)?;
        return Ok(dev_ffmpeg);
    }

    let dev_legacy = PathBuf::from("src-tauri/resources/ffmpeg/ffmpeg");
    if dev_legacy.exists() {
        ensure_executable(&dev_legacy)?;
        return Ok(dev_legacy);
    }
    
    // Last resort: system FFmpeg
    let system_ffmpeg = PathBuf::from("ffmpeg");
    ensure_executable(&system_ffmpeg)?;
    Ok(system_ffmpeg)
}

fn ensure_executable(path: &PathBuf) -> Result<(), String> {
    if is_bare_command(path) {
        return Ok(());
    }
    if !path.exists() {
        return Err(format!("Tool not found at {}", path.display()));
    }
    #[cfg(unix)]
    {
        let metadata = fs::metadata(path)
            .map_err(|e| format!("Failed to read metadata for {}: {}", path.display(), e))?;
        let mut perms = metadata.permissions();
        let mode = perms.mode();
        if mode & 0o111 == 0 {
            perms.set_mode(mode | 0o111);
            fs::set_permissions(path, perms)
                .map_err(|e| format!("Failed to set executable bit for {}: {}", path.display(), e))?;
        }
    }
    Ok(())
}

fn is_bare_command(path: &PathBuf) -> bool {
    path.components().count() == 1
        && path.to_string_lossy().chars().all(|c| c != '/' && c != '\\')
}

fn build_debug_report(
    input_path: &str,
    ffmpeg_path: Option<&PathBuf>,
    webpmux_path: Option<&PathBuf>,
    dwebp_path: Option<&PathBuf>,
    error: &str,
) -> String {
    let resource_dir = format!("{:?}", std::env::var("TAURI_RESOURCE_DIR").ok());
    let mut report = String::new();
    report.push_str("WebP conversion failure report\n");
    report.push_str(&format!("Input: {}\n", input_path));
    report.push_str(&format!("Arch: {}\n", std::env::consts::ARCH));
    report.push_str(&format!("TAURI_RESOURCE_DIR: {}\n", resource_dir));
    if let Some(path) = ffmpeg_path {
        report.push_str(&format!("ffmpeg: {} (exists: {})\n", path.display(), path.exists()));
    }
    if let Some(path) = webpmux_path {
        report.push_str(&format!("webpmux: {} (exists: {})\n", path.display(), path.exists()));
    }
    if let Some(path) = dwebp_path {
        report.push_str(&format!("dwebp: {} (exists: {})\n", path.display(), path.exists()));
    }
    report.push_str(&format!("Error:\n{}\n", error));
    report
}

fn write_debug_log(app: &tauri::AppHandle, contents: &str) -> Option<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .ok()
        .or_else(|| Some(std::env::temp_dir()))?;
    let _ = fs::create_dir_all(&dir);
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_millis();
    let path = dir.join(format!("webpconv-error-{}.log", stamp));
    if fs::write(&path, contents).is_ok() {
        Some(path)
    } else {
        None
    }
}

fn emit_progress(app: &tauri::AppHandle, job_id: &str, progress: u8, stage: &str) {
    let _ = app.emit(
        "conversion-progress",
        ProgressPayload {
            job_id: job_id.to_string(),
            progress,
            stage: stage.to_string(),
        },
    );
}

#[derive(Clone, serde::Serialize)]
struct ProgressPayload {
    job_id: String,
    progress: u8,
    stage: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConvertOptions {
    output_dir: Option<String>,
    quality: Option<String>,
    fps: Option<u32>,
    background: Option<String>,
    output_format: Option<String>,
    output_name_template: Option<String>,
    sequence: Option<u32>,
    static_duration: Option<f64>,
}

struct ConversionSettings {
    output_dir: Option<String>,
    crf: u8,
    preset: String,
    fps: Option<u32>,
    background: Option<String>,
    output_format: String,
    output_name_template: String,
    sequence: u32,
    static_duration: f64,
}

impl ConversionSettings {
    fn from_options(options: &ConvertOptions) -> Result<Self, String> {
        let output_dir = options
            .output_dir
            .as_deref()
            .and_then(|dir| {
                let trimmed = dir.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            });
        let quality = options
            .quality
            .as_deref()
            .unwrap_or("high")
            .to_lowercase();
        let (crf, preset) = match quality.as_str() {
            "balanced" => (18, "medium"),
            "small" => (24, "fast"),
            _ => (12, "slow"),
        };
        let output_format = options
            .output_format
            .as_deref()
            .unwrap_or("mp4")
            .to_lowercase();
        let output_format = match output_format.as_str() {
            "mov" => "mov",
            _ => "mp4",
        }
        .to_string();
        let output_name_template = options
            .output_name_template
            .as_deref()
            .unwrap_or("{name}")
            .trim()
            .to_string();
        let sequence = options.sequence.unwrap_or(1);
        let static_duration = options.static_duration.unwrap_or(1.0);
        let static_duration = if static_duration.is_finite() {
            static_duration
        } else {
            1.0
        }
        .max(0.1)
        .min(60.0);
        Ok(Self {
            output_dir,
            crf,
            preset: preset.to_string(),
            fps: options.fps,
            background: options.background.clone(),
            output_format,
            output_name_template,
            sequence,
            static_duration,
        })
    }

    fn background_rgba(&self) -> Rgba<u8> {
        if let Some(color) = &self.background {
            if let Some(rgba) = parse_hex_color(color) {
                return rgba;
            }
        }
        Rgba([255, 255, 255, 255])
    }
}

fn parse_hex_color(color: &str) -> Option<Rgba<u8>> {
    let trimmed = color.trim().trim_start_matches('#');
    match trimmed.len() {
        6 => {
            let r = u8::from_str_radix(&trimmed[0..2], 16).ok()?;
            let g = u8::from_str_radix(&trimmed[2..4], 16).ok()?;
            let b = u8::from_str_radix(&trimmed[4..6], 16).ok()?;
            return Some(Rgba([r, g, b, 255]));
        }
        8 => {
            let r = u8::from_str_radix(&trimmed[0..2], 16).ok()?;
            let g = u8::from_str_radix(&trimmed[2..4], 16).ok()?;
            let b = u8::from_str_radix(&trimmed[4..6], 16).ok()?;
            let a = u8::from_str_radix(&trimmed[6..8], 16).ok()?;
            return Some(Rgba([r, g, b, a]));
        }
        _ => None,
    }
}

fn build_ffmpeg_filter(settings: &ConversionSettings) -> String {
    let base = "pad=ceil(iw/2)*2:ceil(ih/2)*2";
    if let Some(color) = &settings.background {
        if parse_hex_color(color).is_some() {
            let color = color.trim().trim_start_matches('#');
            return format!(
                "format=rgba,color=c=#{}:s=iw:ih[bg];[bg][0:v]overlay=0:0,{}",
                color, base
            );
        }
    }
    base.to_string()
}

fn render_output_name(template: &str, input_stem: &str, sequence: u32, ext: &str) -> String {
    let (date, time) = format_date_time();
    let counter = sequence.to_string();
    let mut name = template.to_string();
    name = replace_token(&name, "name", input_stem);
    name = replace_token(&name, "counter", &counter);
    name = replace_token(&name, "date", &date);
    name = replace_token(&name, "time", &time);
    name = replace_token(&name, "ext", ext);
    name = sanitize_filename(name.trim());
    name = strip_trailing_extension(&name, ext);
    if name.is_empty() {
        sanitize_filename(input_stem)
    } else {
        name
    }
}

fn sanitize_filename(value: &str) -> String {
    let mut sanitized = String::new();
    for ch in value.chars() {
        match ch {
            '/' | '\\' | ':' => sanitized.push('-'),
            _ => sanitized.push(ch),
        }
    }
    sanitized.trim().to_string()
}

fn replace_token(source: &str, token: &str, value: &str) -> String {
    let brace = format!("{{{}}}", token);
    let bracket = format!("[{}]", token);
    source.replace(&brace, value).replace(&bracket, value)
}

fn strip_trailing_extension(value: &str, ext: &str) -> String {
    if ext.is_empty() {
        return value.to_string();
    }
    let lower = value.to_lowercase();
    let suffix = format!(".{}", ext.to_lowercase());
    if lower.ends_with(&suffix) && value.len() >= suffix.len() {
        let new_len = value.len() - suffix.len();
        return value[..new_len].to_string();
    }
    value.to_string()
}

fn format_date_time() -> (String, String) {
    let now = OffsetDateTime::now_utc();
    let date_format = format_description::parse("[year][month][day]").unwrap();
    let time_format = format_description::parse("[hour][minute][second]").unwrap();
    let date = now
        .format(&date_format)
        .unwrap_or_else(|_| "00000000".to_string());
    let time = now
        .format(&time_format)
        .unwrap_or_else(|_| "000000".to_string());
    (date, time)
}

fn ensure_unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_string();
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("output")
        .to_string();
    let parent = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let mut index = 1;
    loop {
        let candidate_name = format!("{}-{}", stem, index);
        let mut candidate = parent.join(&candidate_name);
        if !ext.is_empty() {
            candidate.set_extension(&ext);
        }
        if !candidate.exists() {
            return candidate;
        }
        index += 1;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            app.listen("app-ready", move |_| {
                if let Some(main_window) = app_handle.get_webview_window("main") {
                    let _ = main_window.show();
                    let _ = main_window.set_focus();
                }
            });
            let fallback_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(5));
                if let Some(main_window) = fallback_handle.get_webview_window("main") {
                    if !main_window.is_visible().unwrap_or(false) {
                        let _ = main_window.show();
                        let _ = main_window.set_focus();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![convert_webp_to_mp4])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
