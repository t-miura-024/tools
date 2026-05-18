use console::Style;
use indicatif::{ProgressBar, ProgressStyle};

pub fn intro(title: &str) {
    let title_style = Style::new().cyan().bold();
    let width = console::measure_text_width(title);
    println!("\n{}", title_style.apply_to(title));
    println!("{}", "─".repeat(width));
}

pub fn outro(msg: &str) {
    println!();
    let dim = Style::new().dim();
    println!("{}", dim.apply_to(msg));
}

pub fn info(msg: &str) {
    let info_style = Style::new().blue();
    println!("  {} {}", info_style.apply_to("●"), msg);
}

pub fn error(msg: &str) {
    let err_style = Style::new().red().bold();
    eprintln!("  {} {}", err_style.apply_to("✗"), msg);
}

pub fn success(msg: &str) {
    let ok_style = Style::new().green().bold();
    println!("  {} {}", ok_style.apply_to("✔"), msg);
}

pub fn warn(msg: &str) {
    let warn_style = Style::new().yellow();
    println!("  {} {}", warn_style.apply_to("⚠"), msg);
}

pub fn spinner(msg: &str) -> ProgressBar {
    let pb = ProgressBar::new_spinner();
    pb.set_style(
        ProgressStyle::default_spinner()
            .template("{spinner:.blue} {msg}")
            .unwrap(),
    );
    pb.set_message(msg.to_string());
    pb.enable_steady_tick(std::time::Duration::from_millis(100));
    pb
}
