//! Computer tool: screenshot and input injection via the computer-use crate.

use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_computer_use::{ComputerAction, ComputerUse};
use prricode_provider::ToolDef;
use serde_json::{json, Value};

pub struct ComputerTool;

#[async_trait]
impl Tool for ComputerTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "computer".to_string(),
            description: "Control the computer: take a screenshot (returned as an image you can see), move/click the mouse, type text, press keys, scroll, or drag. Use screenshots to verify what is on screen before acting.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["screenshot", "mouse_move", "left_click", "right_click", "middle_click", "double_click", "type", "key", "scroll", "drag", "wait", "cursor_position"],
                        "description": "Which action to perform"
                    },
                    "x": { "type": "integer", "description": "Target x coordinate" },
                    "y": { "type": "integer", "description": "Target y coordinate" },
                    "text": { "type": "string", "description": "Text to type (action=type)" },
                    "key": { "type": "string", "description": "Key or combo, xdotool syntax (action=key), e.g. Return, ctrl+c" },
                    "direction": { "type": "string", "enum": ["up", "down", "left", "right"], "description": "Scroll direction" },
                    "amount": { "type": "integer", "description": "Scroll clicks", "default": 3 },
                    "ms": { "type": "integer", "description": "Wait duration in milliseconds (action=wait)", "default": 1000 }
                },
                "required": ["action"]
            }),
        }
    }

    fn risk(&self) -> Risk {
        Risk::Sensitive
    }

    async fn execute(&self, _ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let action_name = input
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing 'action'".into()))?;
        let coordinate =
            |field: &str| -> i32 { input.get(field).and_then(|v| v.as_i64()).unwrap_or(0) as i32 };
        let action = match action_name {
            "screenshot" => ComputerAction::Screenshot,
            "mouse_move" => ComputerAction::MouseMove {
                x: coordinate("x"),
                y: coordinate("y"),
            },
            "left_click" => ComputerAction::LeftClick,
            "right_click" => ComputerAction::RightClick,
            "middle_click" => ComputerAction::MiddleClick,
            "double_click" => ComputerAction::DoubleClick,
            "type" => {
                let text = input.get("text").and_then(|v| v.as_str()).ok_or_else(|| {
                    super::ToolError::InvalidInput("action=type needs 'text'".into())
                })?;
                ComputerAction::Type {
                    text: text.to_string(),
                }
            }
            "key" => {
                let key = input.get("key").and_then(|v| v.as_str()).ok_or_else(|| {
                    super::ToolError::InvalidInput("action=key needs 'key'".into())
                })?;
                ComputerAction::Key {
                    key: key.to_string(),
                }
            }
            "scroll" => ComputerAction::Scroll {
                x: coordinate("x"),
                y: coordinate("y"),
                direction: input
                    .get("direction")
                    .and_then(|v| v.as_str())
                    .unwrap_or("down")
                    .to_string(),
                amount: input.get("amount").and_then(|v| v.as_i64()).unwrap_or(3) as i32,
            },
            "drag" => ComputerAction::Drag {
                x: coordinate("x"),
                y: coordinate("y"),
            },
            "wait" => ComputerAction::Wait {
                ms: input.get("ms").and_then(|v| v.as_u64()).unwrap_or(1000),
            },
            "cursor_position" => ComputerAction::CursorPosition,
            other => {
                return Err(super::ToolError::InvalidInput(format!(
                    "unknown action: {other}"
                )))
            }
        };

        let computer = ComputerUse::probe();
        if !computer.available() {
            return Ok(ToolOutput::error(
                "computer use unavailable: no X11 display (set DISPLAY)".to_string(),
            ));
        }
        if matches!(action, ComputerAction::Screenshot) {
            let bytes = computer
                .screenshot()
                .map_err(|e| super::ToolError::Execution(e.to_string()))?;
            return Ok(ToolOutput {
                content: vec![
                    prricode_provider::ContentPart::text(format!(
                        "screenshot captured ({} bytes)",
                        bytes.len()
                    )),
                    prricode_provider::ContentPart::Image {
                        media_type: "image/png".to_string(),
                        data_base64: base64_encode(&bytes),
                    },
                ],
                is_error: false,
            });
        }
        let result = computer
            .execute(&action)
            .map_err(|e| super::ToolError::Execution(e.to_string()))?;
        Ok(ToolOutput::text(result))
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
