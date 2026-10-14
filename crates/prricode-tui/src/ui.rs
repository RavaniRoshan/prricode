//! Terminal setup, event polling, and rendering.

use crate::app::{App, KeyAction, Role};
use crate::theme::Theme;
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::Terminal;
use std::io::Stdout;

type Term = Terminal<CrosstermBackend<Stdout>>;

/// The active theme's palette. Every color the renderer draws comes from
/// here, so `/theme` restyles the whole surface.
fn palette(app: &App) -> &Theme {
    app.theme_store.active()
}

pub fn init_terminal() -> anyhow::Result<Term> {
    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let terminal = Terminal::new(backend)?;
    Ok(terminal)
}

pub fn restore_terminal() -> anyhow::Result<()> {
    disable_raw_mode()?;
    execute!(std::io::stdout(), LeaveAlternateScreen)?;
    Ok(())
}

/// Poll for the next keyboard event using the Reference composer keymap:
/// Ctrl+<c> and Alt+<c> arrive as their own actions.
pub fn next_event(timeout: std::time::Duration) -> anyhow::Result<Option<KeyAction>> {
    if !event::poll(timeout)? {
        return Ok(None);
    }
    let Event::Key(KeyEvent {
        code, modifiers, ..
    }) = event::read()?
    else {
        return Ok(None);
    };
    let action = match code {
        KeyCode::Char(c) if modifiers.contains(KeyModifiers::CONTROL) => KeyAction::Ctrl(c),
        KeyCode::Char(c) if modifiers.contains(KeyModifiers::ALT) => KeyAction::Alt(c),
        KeyCode::Char(c) => KeyAction::Char(c),
        KeyCode::Enter => KeyAction::Enter,
        KeyCode::Backspace => KeyAction::Backspace,
        KeyCode::Delete => KeyAction::Delete,
        KeyCode::Esc => KeyAction::Esc,
        KeyCode::Left => KeyAction::Left,
        KeyCode::Right => KeyAction::Right,
        KeyCode::Up => KeyAction::Up,
        KeyCode::Down => KeyAction::Down,
        KeyCode::Home => KeyAction::Home,
        KeyCode::End => KeyAction::End,
        KeyCode::PageUp => KeyAction::PageUp,
        KeyCode::PageDown => KeyAction::PageDown,
        _ => return Ok(None),
    };
    Ok(Some(action))
}

pub fn render(frame: &mut ratatui::Frame<'_>, app: &App) {
    let area = frame.area();
    if app.should_quit {
        return;
    }
    // Ctrl+C sentinel quits from the event layer.
    if app.pending_approval.is_some() {
        render_approval(frame, app, area);
    } else {
        render_main(frame, app, area);
    }
}

fn render_main(frame: &mut ratatui::Frame<'_>, app: &App, area: Rect) {
    let theme = palette(app);
    let chunks = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(5),
        Constraint::Length(3),
        Constraint::Length(1),
    ])
    .split(area);

    let header = Paragraph::new(Line::from({
        let mut spans = vec![
            Span::styled(
                "prricode",
                Style::default()
                    .fg(theme.accent)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw("  "),
            Span::styled(
                format!("session {}", &app.session_id.to_string()[..8]),
                Style::default().fg(theme.session),
            ),
            Span::raw("  "),
            Span::styled(app.status_base_line(), Style::default().fg(theme.status)),
        ];
        // Product-builder pipeline rail, styled as its own segments.
        if let Some(pipeline) = &app.pipeline {
            spans.push(Span::styled(
                format!(" · stage: {}", pipeline.stage),
                Style::default().fg(theme.rail_stage),
            ));
            if let Some(gate) = &pipeline.gate {
                spans.push(Span::styled(
                    format!(" · gate: {gate}"),
                    Style::default()
                        .fg(theme.rail_gate)
                        .add_modifier(Modifier::BOLD),
                ));
            }
            if let Some(verify) = pipeline.verify_segment() {
                spans.push(Span::styled(
                    format!(" · {verify}"),
                    Style::default().fg(theme.rail_ok),
                ));
            }
            if let Some(ship) = pipeline.ship_segment() {
                spans.push(Span::styled(
                    format!(" · {ship}"),
                    Style::default().fg(theme.rail_ok),
                ));
            }
        }
        spans
    }))
    .block(Block::default().borders(Borders::BOTTOM));
    frame.render_widget(header, chunks[0]);

    // Conversation.
    let mut lines: Vec<Line<'_>> = Vec::new();
    for message in app.rendered_messages() {
        let (prefix, style) = match message.role {
            Role::User => ("you › ", Style::default().fg(theme.user)),
            Role::Assistant => ("agent › ", Style::default().fg(theme.assistant)),
            Role::Tool => ("tool › ", Style::default().fg(theme.tool)),
            Role::System => ("sys › ", Style::default().fg(theme.system)),
        };
        for (i, line) in message.text.lines().enumerate() {
            if i == 0 {
                lines.push(Line::from(vec![
                    Span::styled(prefix, style.add_modifier(Modifier::BOLD)),
                    Span::raw(line.to_string()),
                ]));
            } else {
                lines.push(Line::from(Span::raw(format!("      {line}"))));
            }
        }
        lines.push(Line::from(""));
    }
    let visible = chunks[1].height.saturating_sub(1) as usize;
    let total = lines.len();
    let scroll = (app.scroll as usize).min(total.saturating_sub(visible));
    let offset = total.saturating_sub(visible).saturating_sub(scroll);
    let conversation = Paragraph::new(lines)
        .block(Block::default().borders(Borders::TOP).title("conversation"))
        .wrap(Wrap { trim: false })
        .scroll((offset as u16, 0));
    frame.render_widget(conversation, chunks[1]);

    // Input. While a secret value is being collected the composer renders
    // one mask character per character typed, so the value never shows.
    let (composer, title) = if app.secret_input {
        (
            app.composer_text(),
            format!(
                "secret: {}  (Enter submit · Esc cancel — masked)",
                app.secret_name.as_deref().unwrap_or("value")
            ),
        )
    } else {
        (
            app.input.clone(),
            "input  (Enter send · Esc cancel · /help)".to_string(),
        )
    };
    let input = Paragraph::new(composer.as_str())
        .style(Style::default().fg(theme.foreground))
        .block(Block::default().borders(Borders::ALL).title(title));
    frame.render_widget(input, chunks[2]);
    // Cursor follows the composer cursor (clamped to the visible line).
    let visible = app
        .composer_text()
        .chars()
        .take(app.cursor)
        .collect::<String>();
    let (row, column) = visible
        .rsplit_once('\n')
        .map(|(_, tail)| (1, tail.chars().count() as u16))
        .unwrap_or((0, visible.chars().count() as u16));
    let max_column = chunks[2].width.saturating_sub(2);
    frame.set_cursor_position((
        chunks[2].x + 1 + column.min(max_column),
        chunks[2].y + 1 + row.min(chunks[2].height.saturating_sub(2)),
    ));

    // Footer.
    let footer = Paragraph::new(Line::from(vec![
        Span::styled("Esc", Style::default().fg(theme.footer_key)),
        Span::raw(" cancel  "),
        Span::styled("PgUp/PgDn", Style::default().fg(theme.footer_key)),
        Span::raw(" scroll  "),
        Span::styled("/model", Style::default().fg(theme.footer_command)),
        Span::raw(" switch model  "),
        Span::styled("/approval", Style::default().fg(theme.footer_command)),
        Span::raw(" approval mode  "),
        Span::styled("/quit", Style::default().fg(theme.footer_command)),
        Span::raw(" quit"),
    ]));
    frame.render_widget(footer, chunks[3]);
}

fn render_approval(frame: &mut ratatui::Frame<'_>, app: &App, area: Rect) {
    // Conversation behind the modal.
    render_main(frame, app, area);
    if let Some(approval) = &app.pending_approval {
        let theme = palette(app);
        let popup = centered_rect(74, 8, area);
        frame.render_widget(Clear, popup);
        let text = vec![
            Line::from(vec![Span::styled(
                "approval required",
                Style::default()
                    .fg(theme.approval)
                    .add_modifier(Modifier::BOLD),
            )]),
            Line::from(""),
            Line::from(vec![
                Span::styled("tool: ", Style::default().fg(theme.system)),
                Span::raw(approval.kind.clone()),
            ]),
            Line::from(Span::raw(approval.summary.clone())),
            Line::from(""),
            Line::from(vec![
                Span::styled(
                    "[y]",
                    Style::default().fg(theme.user).add_modifier(Modifier::BOLD),
                ),
                Span::raw(" allow once  "),
                Span::styled(
                    "[s]",
                    Style::default()
                        .fg(theme.assistant)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(" allow for session  "),
                Span::styled(
                    "[a]",
                    Style::default()
                        .fg(theme.rail_stage)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(" always in workspace  "),
                Span::styled(
                    "[n]",
                    Style::default()
                        .fg(theme.approval)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(" deny"),
            ]),
        ];
        let popup_widget = Paragraph::new(text).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(theme.approval_border))
                .title("approve?"),
        );
        frame.render_widget(popup_widget, popup);
    }
}

fn centered_rect(percent_x: u16, height: u16, area: Rect) -> Rect {
    let popup_layout = Layout::vertical([
        Constraint::Percentage(50),
        Constraint::Length(height),
        Constraint::Percentage(50),
    ])
    .split(area);
    let vertical = Layout::horizontal([
        Constraint::Percentage((100 - percent_x) / 2),
        Constraint::Percentage(percent_x),
        Constraint::Percentage((100 - percent_x) / 2),
    ])
    .split(popup_layout[1]);
    vertical[1]
}
