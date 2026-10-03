import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Truck } from 'lucide-react';
import type { CustomerContact } from '../../api/client';
import { ContactReach } from './ContactReach';
import { contactTitle, deliveryLine } from './contactFormat';

/**
 * A customer's contacts in its page's side panel (WS-13 E11 E03, the mockup's
 * `.m-contactlist`): the main one first with its badge, then the role, the phone and
 * e-mail as links, the delivery after a truck, the code and the contact's own note. The
 * server orders them; the first is the main one (spec workshop-customers, rule 22).
 */
export function CustomerContactsSection({ contacts }: { contacts: CustomerContact[] }) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="mb-4">
      <h3 id={headingId} className="text-sm font-semibold text-white mb-2.5">
        {t('customers.contacts.title')}
      </h3>
      {contacts.length === 0 ? (
        <p className="text-sm text-bambu-gray">{t('customers.contacts.none')}</p>
      ) : (
        <ul className="grid gap-2.5">
          {contacts.map((c, index) => (
            <li key={c.id} className="text-sm space-y-0.5 min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <b className="text-white font-semibold break-words">{contactTitle(c)}</b>
                {index === 0 && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-bambu-green/15 text-bambu-green">
                    {t('customers.contacts.main')}
                  </span>
                )}
              </div>
              {c.role && <div className="text-xs text-bambu-gray">{c.role}</div>}
              <div className="text-xs text-bambu-gray break-words">
                {c.phone || c.email ? <ContactReach contact={c} /> : '—'}
              </div>
              {deliveryLine(c) && (
                <div className="flex items-start gap-1 text-xs text-bambu-gray">
                  <Truck className="w-3 h-3 mt-0.5 flex-shrink-0" aria-hidden />
                  <span className="break-words">{deliveryLine(c)}</span>
                </div>
              )}
              <div className="text-xs text-bambu-gray">{c.code}</div>
              {c.note && <div className="text-xs text-bambu-gray whitespace-pre-line">{c.note}</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
