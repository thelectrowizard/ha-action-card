# Action Card

An invisible Home Assistant dashboard card that runs an action whenever the dashboard is loaded or reloaded.

The card takes up no space on the dashboard. While you are editing the dashboard it shows a small placeholder with its action, timing and last status, so you can find and configure it.

## Installation

### HACS (custom repository)

1. In HACS, open the menu and choose **Custom repositories**.
2. Add `https://github.com/thelectrowizard/ha-action-card` with the category **Dashboard**.
3. Install **Action Card** and reload your browser.

### Manual

1. Copy `ha-action-card.js` to `config/www/ha-action-card.js`.
2. Go to **Settings → Dashboards → ⋮ → Resources** and add `/local/ha-action-card.js` as a **JavaScript module**.
3. Reload your browser.

## Usage

Edit a dashboard, add a card and pick **Action Card**. The visual editor lets you choose:

| Option | Default | Description |
| --- | --- | --- |
| `action` | — | The action to run. Accepts any action you can perform in Home Assistant, a navigation, or a URL. |
| `delay` | `0` | Seconds to wait after the dashboard loads before running the action. |
| `timeout` | `10` | Seconds to wait for the action to finish before reporting it as failed. `0` waits forever. |
| `cooldown` | `0` | Skip the action if this browser already ran it within this many seconds, even across page reloads. `0` disables it. |
| `run_on` | `page_load` | `page_load` runs once each time the page is loaded or reloaded. `view_load` also runs whenever you switch back to the view. |
| `run_in_edit_mode` | `false` | Also run the action while the dashboard is being edited. |
| `notify_on_error` | `true` | Show a notification if the action fails or times out. |

If you leave the view before the delay has elapsed, the action is cancelled.

### YAML examples

```yaml
type: custom:ha-action-card
action:
  action: perform-action
  perform_action: light.turn_on
  target:
    entity_id: light.hallway
  data:
    brightness_pct: 60
delay: 2
timeout: 15
cooldown: 300
```

Shorthand forms are accepted too:

```yaml
type: custom:ha-action-card
action: script.dashboard_opened
data:
  source: wall_tablet
```

```yaml
type: custom:ha-action-card
service: input_boolean.turn_on   # legacy form
service_data:
  entity_id: input_boolean.dashboard_open
```
