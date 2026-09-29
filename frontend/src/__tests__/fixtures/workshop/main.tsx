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
import { WorkshopDialog, type WorkshopDialogSize } from '../../../components/workshop/WorkshopDialog';
import { WorkshopField, WorkshopFormGrid } from '../../../components/workshop/WorkshopFormGrid';
import { CardActionMenu, CardActionMenuItem } from '../../../components/CardActionMenu';
import { Button } from '../../../components/Button';

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

const FIELD = 'w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 text-sm text-white';
const LONG_ERROR = Array.from({ length: 14 }, (_, i) =>
  `Рядок ${i + 1}: сервер відмовив — позиція змінилась, поки форма була відкрита (409). `,
).join('');

/**
 * Dialog recipes, all from the URL so a browser run is deterministic:
 * ?dialog=sm|md|lg|xl — opened on load; &subtitle=0 — without one; &error=short|long;
 * &pending=1; &long=1 — a form taller than the viewport.
 */
function Dialogs() {
  const formId = useId();
  const [size, setSize] = useState<WorkshopDialogSize | null>((params.get('dialog') as WorkshopDialogSize) || null);
  const [nested, setNested] = useState(false);
  const [submitted, setSubmitted] = useState(0);
  const pending = params.get('pending') === '1';
  const errorKind = params.get('error');
  const error =
    errorKind === 'long' ? LONG_ERROR : errorKind === 'short' ? 'Замовник змінився, поки ви редагували (409).' : undefined;
  const long = params.get('long') === '1';
  return (
    <section data-fixture="dialogs" className="flex flex-wrap gap-2">
      {(['sm', 'md', 'lg', 'xl'] as const).map((s) => (
        <button key={s} type="button" data-fixture={`open-${s}`} className="text-sm text-bambu-gray" onClick={() => setSize(s)}>
          open {s}
        </button>
      ))}
      <output data-fixture="submitted" className="text-sm text-bambu-gray">
        {submitted}
      </output>
      {size && (
        <WorkshopDialog
          size={size}
          title={`Нове замовлення · ${size} · дуже довгий заголовок, що має переноситись, а не штовхати хрестик`}
          subtitle={params.get('subtitle') === '0' ? undefined : 'Для кого, що й до якого терміну — <b>текст, не HTML</b>'}
          pending={pending}
          error={error}
          onClose={() => setSize(null)}
          summary={<span>3 позиції · 12 од.</span>}
          footer={
            <>
              <Button type="button" variant="secondary" disabled={pending} onClick={() => setSize(null)}>
                Скасувати
              </Button>
              <Button type="submit" form={formId} disabled={pending}>
                Створити
              </Button>
            </>
          }
        >
          <form
            id={formId}
            data-fixture="form"
            onSubmit={(e) => {
              e.preventDefault();
              setSubmitted((n) => n + 1);
            }}
          >
            <WorkshopFormGrid>
              <WorkshopField label="Назва" htmlFor="fx-name" hint="Як її бачить замовник">
                <input id="fx-name" required aria-describedby="fx-name-hint" className={FIELD} />
              </WorkshopField>
              <WorkshopField label="Замовник" htmlFor="fx-customer">
                <select id="fx-customer" className={FIELD}>
                  <option>ACME</option>
                  <option>Дуже довга назва замовника, яка не повинна розширити колонку сітки</option>
                </select>
              </WorkshopField>
              <WorkshopField label="Нотатка" htmlFor="fx-note" full>
                <textarea id="fx-note" rows={3} className={FIELD} />
              </WorkshopField>
              {long &&
                Array.from({ length: 16 }, (_, i) => (
                  <WorkshopField key={i} label={`Поле ${i + 1}`} htmlFor={`fx-extra-${i}`}>
                    <input id={`fx-extra-${i}`} className={FIELD} />
                  </WorkshopField>
                ))}
            </WorkshopFormGrid>
          </form>
          <CardActionMenu label="Дії з формою" testId="fixture-menu">
            {(close) => (
              <>
                <CardActionMenuItem onSelect={() => close()}>Дублювати</CardActionMenuItem>
                <CardActionMenuItem disabled onSelect={() => close()}>
                  Недоступна дія
                </CardActionMenuItem>
                <CardActionMenuItem
                  onSelect={() => {
                    close();
                    setNested(true);
                  }}
                >
                  Відкрити вкладений діалог
                </CardActionMenuItem>
              </>
            )}
          </CardActionMenu>
          {nested && (
            <WorkshopDialog size="sm" title="Вкладений діалог" onClose={() => setNested(false)}>
              <p className="text-sm text-bambu-gray-light">Escape закриває лише цей.</p>
            </WorkshopDialog>
          )}
        </WorkshopDialog>
      )}
    </section>
  );
}

function Fixture() {
  return (
    <main className="workshop min-h-screen space-y-8 bg-bambu-dark p-4 text-white">
      <Tabs />
      <Dialogs />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
