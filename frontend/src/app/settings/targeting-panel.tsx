'use client';

import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

type Targeting = {
  presets: Array<{ id: string; label: string; group: string }>;
  selected: string[];
  legacy: string[];
  cities: Array<{ city: string; country: string }>;
  markets: Array<{ code: string; name: string }>;
};

export default function TargetingPanel() {
  const [state, setState] = useState<Targeting | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [cities, setCities] = useState<Array<{ city: string; country: string }>>([]);
  const [newCity, setNewCity] = useState('');
  const [newCountry, setNewCountry] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const apply = (data: Targeting) => {
    setState(data);
    setSelected(data.selected);
    setCities(data.cities);
    setNewCountry((current) => current || data.cities[0]?.country || data.markets[0]?.code || '');
  };

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/proxy/settings/targeting', { cache: 'no-store' });
        if (!response.ok) throw new Error();
        apply(await response.json() as Targeting);
      } catch {
        setError('Could not load targeting. Press Refresh at the top of the page to try again.');
      }
    })();
  }, []);

  const groups = useMemo(() => {
    const map = new Map<string, Targeting['presets']>();
    for (const preset of state?.presets ?? []) map.set(preset.group, [...(map.get(preset.group) ?? []), preset]);
    return [...map.entries()];
  }, [state]);

  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const allSelected = !!state && selected.length === state.presets.length;

  const addCity = () => {
    const city = newCity.trim().replace(/\s+/g, ' ');
    if (!city || !newCountry) return;
    if (cities.some((item) => item.city.toLowerCase() === city.toLowerCase() && item.country === newCountry)) { setNewCity(''); return; }
    setCities((current) => [...current, { city, country: newCountry }]);
    setNewCity('');
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/proxy/settings/targeting', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ niches: selected, cities }),
      });
      const result = await response.json().catch(() => null) as (Targeting & { message?: string }) | null;
      if (!response.ok || !result?.presets) throw new Error(result?.message ?? 'Could not save targeting.');
      apply(result);
      setNotice(`Saved: ${result.selected.length} business types in ${result.cities.length} ${result.cities.length === 1 ? 'city' : 'cities'}. Run the "Import businesses" workflow in GitHub Actions to fetch them now, or wait for Monday's weekly import.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save targeting.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-panel" id="targeting">
      <div className="admin-panel-heading">
        <div>
          <div className="section-kicker">LEAD SOURCES</div>
          <h2>Targeting</h2>
          <p>Business types and cities to find leads in. A weekly import pulls them from Overture Maps open data; OpenStreetMap fills gaps between imports.</p>
        </div>
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {notice && <div className="admin-notice" role="status">{notice}</div>}
      {!state ? (!error && <p className="admin-empty">Loading targeting…</p>) : (
        <form onSubmit={save} className="targeting-form">
          <div className="targeting-heading">
            <strong>Business types</strong>
            <button type="button" className="text-button" onClick={() => setSelected(allSelected ? [] : state.presets.map((preset) => preset.id))}>{allSelected ? 'Clear all' : 'Select all'}</button>
          </div>
          {groups.map(([group, presets]) => (
            <div className="targeting-group" key={group}>
              <span className="targeting-group-title">{group}</span>
              <div className="chip-row">
                {presets.map((preset) => (
                  <button type="button" key={preset.id} aria-pressed={selected.includes(preset.id)} className={`chip${selected.includes(preset.id) ? ' on' : ''}`} onClick={() => toggle(preset.id)}>
                    {selected.includes(preset.id) && <span aria-hidden="true">✓ </span>}{preset.label}
                  </button>
                ))}
              </div>
            </div>
          ))}

          <div className="targeting-heading"><strong>Cities</strong><small>{cities.length}/10</small></div>
          {!cities.length && <p className="admin-empty">No cities yet.</p>}
          <div className="chip-row">
            {cities.map((item) => (
              <span className="chip on removable" key={`${item.country}:${item.city}`}>
                {item.city}, {item.country}
                <button type="button" aria-label={`Remove ${item.city}`} onClick={() => setCities((current) => current.filter((other) => other !== item))}>×</button>
              </span>
            ))}
          </div>
          <div className="targeting-add">
            <input value={newCity} maxLength={80} placeholder="Add a city, e.g. Vancouver" onChange={(event) => setNewCity(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addCity(); } }} />
            <select value={newCountry} onChange={(event) => setNewCountry(event.target.value)} aria-label="Country">
              {state.markets.map((market) => <option key={market.code} value={market.code}>{market.code}</option>)}
            </select>
            <button type="button" className="reject-button" disabled={!newCity.trim() || cities.length >= 10} onClick={addCity}>Add</button>
          </div>
          {!!state.legacy.length && <p className="portfolio-form-note">Saving replaces the old campaign ({state.legacy.join(', ')}) with your selection.</p>}
          <button className="approve-button" type="submit" disabled={busy || !selected.length || !cities.length}>{busy ? 'Saving…' : 'Save targeting'}</button>
        </form>
      )}
    </section>
  );
}
