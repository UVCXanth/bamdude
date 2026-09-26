import type { CustomerContact } from '../../api/client';

/** A contact's phone and e-mail as links, «phone · email», nothing when neither is there. */
export function ContactReach({ contact, className = '' }: { contact: CustomerContact; className?: string }) {
  if (!contact.phone && !contact.email) return null;
  return (
    <span className={className}>
      {contact.phone && (
        <a href={`tel:${contact.phone.replace(/[^\d+]/g, '')}`} className="hover:text-white">
          {contact.phone}
        </a>
      )}
      {contact.phone && contact.email && ' · '}
      {contact.email && (
        <a href={`mailto:${contact.email}`} className="hover:text-white">
          {contact.email}
        </a>
      )}
    </span>
  );
}
