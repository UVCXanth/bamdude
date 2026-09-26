import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Truck } from 'lucide-react';
import type { CustomerContact } from '../../api/client';
import { ContactReach } from './ContactReach';
import { contactTitle, deliveryLine } from './contactFormat';

/** A customer's contacts on its page (spec workshop-customers, rule 22); the first is the main one. */
export function CustomerContactsSection({ contacts }: { contacts: CustomerContact[] }) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary p-4"
    >
      <h2 id={headingId} className="text-sm font-semibold text-white mb-3">
        {t('customers.contacts.title')}
      </h2>
      {contacts.length === 0 ? (
        <p className="text-sm text-bambu-gray">{t('customers.contacts.none')}</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {contacts.map((c, index) => (
            <li key={c.id} className="text-sm space-y-0.5">
              <div className="flex items-center gap-2">
                <span className="text-white font-medium">{contactTitle(c)}</span>
                {index === 0 && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-bambu-green/15 text-bambu-green">
                    {t('customers.contacts.main')}
                  </span>
                )}
                <span className="text-xs text-bambu-gray">{c.code}</span>
              </div>
              {c.role && <div className="text-xs text-bambu-gray">{c.role}</div>}
              <ContactReach contact={c} className="block text-xs text-bambu-gray" />
              {deliveryLine(c) && (
                <div className="flex items-center gap-1 text-xs text-bambu-gray">
                  <Truck className="w-3 h-3" aria-hidden />
                  {deliveryLine(c)}
                </div>
              )}
              {c.note && <div className="text-xs text-bambu-gray whitespace-pre-line">{c.note}</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
