"use client";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

interface TimeWindow {
  days: typeof DAYS[number][];
  start: string;
  end: string;
}

interface ActiveHoursConfig {
  timezone: string;
  windows: TimeWindow[];
}

export default function ActiveHoursSection({
  value,
  onChange,
}: {
  value: ActiveHoursConfig;
  onChange: (v: ActiveHoursConfig) => void;
}) {
  function updateWindow(idx: number, patch: Partial<TimeWindow>) {
    const windows = [...value.windows];
    windows[idx] = { ...windows[idx], ...patch };
    onChange({ ...value, windows });
  }

  function addWindow() {
    onChange({
      ...value,
      windows: [
        ...value.windows,
        { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
      ],
    });
  }

  function removeWindow(idx: number) {
    onChange({
      ...value,
      windows: value.windows.filter((_, i) => i !== idx),
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <label className="text-sm text-text-secondary w-32">Timezone</label>
        <input
          type="text"
          value={value.timezone}
          onChange={(e) => onChange({ ...value, timezone: e.target.value })}
          placeholder="e.g. America/New_York"
          className="flex-1 bg-background border border-border rounded-md px-3 py-1.5 text-sm text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent"
        />
      </div>

      {value.windows.map((win, idx) => (
        <div key={idx} className="bg-background rounded-md p-3 border border-border">
          <div className="flex flex-wrap gap-2 mb-3">
            {DAYS.map((day) => (
              <button
                key={day}
                type="button"
                onClick={() => {
                  const days = win.days.includes(day)
                    ? win.days.filter((d) => d !== day)
                    : [...win.days, day];
                  updateWindow(idx, { days });
                }}
                className={`px-2 py-1 text-xs rounded font-medium transition-colors ${
                  win.days.includes(day)
                    ? "bg-accent text-white"
                    : "bg-surface text-text-secondary hover:text-text-primary"
                }`}
              >
                {day.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="time"
              value={win.start}
              onChange={(e) => updateWindow(idx, { start: e.target.value })}
              className="bg-surface border border-border rounded px-2 py-1 text-sm text-text-primary focus:outline-none focus:border-accent"
            />
            <span className="text-text-secondary text-sm">to</span>
            <input
              type="time"
              value={win.end}
              onChange={(e) => updateWindow(idx, { end: e.target.value })}
              className="bg-surface border border-border rounded px-2 py-1 text-sm text-text-primary focus:outline-none focus:border-accent"
            />
            {value.windows.length > 1 && (
              <button
                type="button"
                onClick={() => removeWindow(idx)}
                className="text-danger text-xs ml-auto hover:underline"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={addWindow}
        className="text-sm text-accent hover:text-accent-hover"
      >
        + Add time window
      </button>
    </div>
  );
}
