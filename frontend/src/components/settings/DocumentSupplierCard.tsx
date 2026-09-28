import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import { Card, CardContent, CardHeader } from '../Card';

export type SupplierField = 'name' | 'address' | 'phone' | 'code' | 'iban';
const FIELDS: SupplierField[] = ['name', 'address', 'phone', 'code', 'iban'];

/** «Реквізити для документів» (spec workshop-dispatch-notes, rule 11) — copied into each new note. */
export function DocumentSupplierCard({
  values,
  onChange,
}: {
  values: Record<SupplierField, string>;
  onChange: (key: `document_supplier_${SupplierField}`, value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Card id="card-document-supplier">
      <CardHeader>
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <FileText className="w-4 h-4 text-bambu-green" />
          {t('settings.documentSupplier.title')}
        </h2>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-bambu-gray">{t('settings.documentSupplier.hint')}</p>
        {FIELDS.map((key) => (
          <div key={key}>
            <label htmlFor={`document-supplier-${key}`} className="block text-sm text-bambu-gray mb-1">
              {t(`settings.documentSupplier.${key}`)}
            </label>
            <input
              id={`document-supplier-${key}`}
              value={values[key]}
              maxLength={255}
              onChange={(e) => onChange(`document_supplier_${key}`, e.target.value)}
              className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none"
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
