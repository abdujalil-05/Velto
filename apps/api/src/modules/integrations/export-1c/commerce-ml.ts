export interface CommerceMlCustomer {
  id: string;
  code: string;
  name: string;
  phone: string | null;
}

export interface CommerceMlDocumentLine {
  externalCode: string | null;
  sku: string;
  productName: string;
  qty: string;
  unitPrice: string;
  lineTotal: string;
}

export interface CommerceMlDocument {
  id: string;
  number: string;
  date: Date;
  operation: 'Отгрузка товара' | 'Оплата от покупателя';
  customerId: string;
  total: string;
  lines?: CommerceMlDocumentLine[];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatTime(d: Date): string {
  return d.toISOString().slice(11, 19);
}

/**
 * 11.1: "Format: CommerceML 2 (XML)". A pragmatic subset of the real
 * CommerceML 2 exchange schema: every contragent (customer) referenced by
 * the period's documents, plus one <Документ> per sales document (Invoice,
 * ХозОперация="Отгрузка товара") or payment (Payment, "Оплата от
 * покупателя"). Full multi-file exchange-protocol compliance (separate
 * catalog/offer files, price types, etc.) is out of scope — 1C only needs
 * enough here to match contragents and post documents, not a full
 * product-catalog sync.
 */
export function buildCommerceMlXml(params: {
  generatedAt: Date;
  customers: CommerceMlCustomer[];
  documents: CommerceMlDocument[];
  currency: string;
}): string {
  const { generatedAt, customers, documents, currency } = params;

  const contragentsXml = customers
    .map(
      (c) => `    <Контрагент>
      <Ид>${escapeXml(c.id)}</Ид>
      <Наименование>${escapeXml(c.name)}</Наименование>
      <Код>${escapeXml(c.code)}</Код>${c.phone ? `\n      <Телефон>${escapeXml(c.phone)}</Телефон>` : ''}
    </Контрагент>`,
    )
    .join('\n');

  const documentsXml = documents
    .map((doc) => {
      const linesXml = doc.lines?.length
        ? `      <Товары>
${doc.lines
  .map(
    (l) => `        <Товар>
          <Ид>${escapeXml(l.externalCode ?? l.sku)}</Ид>
          <Наименование>${escapeXml(l.productName)}</Наименование>
          <ЦенаЗаЕдиницу>${l.unitPrice}</ЦенаЗаЕдиницу>
          <Количество>${l.qty}</Количество>
          <Сумма>${l.lineTotal}</Сумма>
        </Товар>`,
  )
  .join('\n')}
      </Товары>\n`
        : '';

      return `    <Документ>
      <Ид>${escapeXml(doc.id)}</Ид>
      <Номер>${escapeXml(doc.number)}</Номер>
      <Дата>${formatDate(doc.date)}</Дата>
      <Время>${formatTime(doc.date)}</Время>
      <ХозОперация>${doc.operation}</ХозОперация>
      <Валюта>${escapeXml(currency)}</Валюта>
      <Сумма>${doc.total}</Сумма>
      <Контрагенты>
        <Контрагент>
          <Ид>${escapeXml(doc.customerId)}</Ид>
        </Контрагент>
      </Контрагенты>
${linesXml}    </Документ>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация ВерсияСхемы="2.10" ДатаФормирования="${formatDate(generatedAt)}T${formatTime(generatedAt)}">
  <Контрагенты>
${contragentsXml}
  </Контрагенты>
  <Документы>
${documentsXml}
  </Документы>
</КоммерческаяИнформация>
`;
}
