use anyhow::{Context, Result};
use regex::Regex;

#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    pub heading: String,
    pub text: String,
    pub chunk_index: usize,
}

pub fn split_by_headings(content: &str, pattern: &str) -> Result<Vec<Chunk>> {
    let regex = Regex::new(pattern).with_context(|| format!("不正な chunk_pattern: {pattern}"))?;

    let mut chunks = Vec::new();
    let mut current_heading = String::new();
    let mut current_lines: Vec<&str> = Vec::new();

    for line in content.lines() {
        if regex.is_match(line) {
            if !current_lines.is_empty() {
                let text = current_lines.join("\n").trim().to_string();
                if !text.is_empty() {
                    chunks.push(Chunk {
                        heading: current_heading.clone(),
                        text,
                        chunk_index: chunks.len(),
                    });
                }
            }
            current_heading = line.trim().to_string();
            current_lines.clear();
        } else {
            current_lines.push(line);
        }
    }

    if !current_lines.is_empty() {
        let text = current_lines.join("\n").trim().to_string();
        if !text.is_empty() {
            chunks.push(Chunk {
                heading: current_heading,
                text,
                chunk_index: chunks.len(),
            });
        }
    }

    Ok(chunks)
}

#[cfg(test)]
#[path = "chunk.test.rs"]
mod tests;
