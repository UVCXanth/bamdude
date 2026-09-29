/**
 * WS-13 E2 test fixture (§D, H1): the Workshop primitives mounted with the
 * production components and nothing else — no App, no router, no API, no
 * mutations. A browser recipe measures them here; the pages prove integration.
 *
 * The theme comes from the URL, applied exactly as `ThemeContext` applies it
 * (classes on <html>), so the fixture never reads or writes the user's saved
 * theme: ?mode=dark|light&style=classic&bg=neutral|oled|…&accent=green|…
 */
import { StrictMode, useId, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../index.css';
import '../../../i18n';
import { WorkshopTabPanel, WorkshopTabs, type WorkshopTabItem } from '../../../components/workshop/WorkshopTabs';

const params = new URLSearchParams(window.location.search);
const root = document.documentElement;
if ((params.get('mode') ?? 'dark') === 'dark') root.classList.add('dark');
root.classList.add(`style-${params.get('style') ?? 'classic'}`);
root.classList.add(`bg-${params.get('bg') ?? 'neutral'}`);
root.classList.add(`accent-${params.get('accent') ?? 'green'}`);

type Status = 'active' | 'completed' | 'cancelled' | 'archived' | 'all';
type Section = 'lines' | 'prints' | 'queue' | 'shipments' | 'journal' | 'files' | 'notes' | 'history';

const statusTabs: WorkshopTabItem<Status>[] = [
  { value: 'active', label: 'Активні', count: 12 },
  { value: 'completed', label: 'Виконані', count: 0 },
  { value: 'cancelled', label: 'Скасовані', disabled: true },
  { value: 'archived', label: 'Архівні замовлення з дуже довгою назвою вкладки', count: 1234 },
  { value: 'all', label: 'Усі', count: null },
];

const sectionTabs: WorkshopTabItem<Section>[] = [
  { value: 'lines', label: 'Позиції', count: 4 },
  { value: 'prints', label: 'Друки', count: 18 },
  { value: 'queue', label: 'Черга', count: 0 },
  { value: 'shipments', label: 'Відвантаження', count: 2 },
  { value: 'journal', label: 'Журнал подій замовлення' },
  { value: 'files', label: 'Файли', count: null },
  { value: 'notes', label: 'Нотатки' },
  { value: 'history', label: 'Історія змін <b>не HTML</b>' },
];

function Tabs() {
  const statusId = useId();
  const sectionId = useId();
  const [status, setStatus] = useState<Status>('active');
  const [section, setSection] = useState<Section>('lines');
  return (
    <section data-fixture="tabs" className="space-y-6">
      <button type="button" data-fixture="before-tabs" className="text-sm text-bambu-gray">
        before
      </button>
      <div data-fixture="tabs-filter">
        <WorkshopTabs idBase={statusId} ariaLabel="Статус замовлення" value={status} items={statusTabs} onChange={setStatus} />
        <WorkshopTabPanel idBase={statusId} value={status} className="py-4 text-sm text-bambu-gray-light">
          {status}
        </WorkshopTabPanel>
      </div>
      <div data-fixture="tabs-detail">
        <WorkshopTabs
          idBase={sectionId}
          ariaLabel="Розділи замовлення"
          size="detail"
          value={section}
          items={sectionTabs}
          onChange={setSection}
          busy={params.get('busy') === '1'}
        />
        <WorkshopTabPanel idBase={sectionId} value={section} className="py-4 text-sm text-bambu-gray-light">
          {section}
        </WorkshopTabPanel>
      </div>
      <button type="button" data-fixture="after-tabs" className="text-sm text-bambu-gray">
        after
      </button>
    </section>
  );
}

function Fixture() {
  return (
    <main className="workshop min-h-screen bg-bambu-dark p-4 text-white">
      <Tabs />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
