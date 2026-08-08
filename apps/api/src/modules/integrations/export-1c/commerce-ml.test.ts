import { describe, expect, it } from 'vitest';
import { buildCommerceMlXml } from './commerce-ml';

describe('buildCommerceMlXml', () => {
  const generatedAt = new Date('2026-08-01T10:15:30Z');

  it('renders one <Контрагент> per customer and one <Документ> per document', () => {
    const xml = buildCommerceMlXml({
      generatedAt,
      currency: 'UZS',
      customers: [
        { id: 'cust-1', code: 'C-1', name: 'Do\'kon "Baraka"', phone: '+998901234567' },
      ],
      documents: [
        {
          id: 'inv-1',
          number: 'INV-2026-000001',
          date: new Date('2026-08-01T09:00:00Z'),
          operation: 'Отгрузка товара',
          customerId: 'cust-1',
          total: '150000.00',
          lines: [
            { externalCode: '1C-001', sku: 'SKU-001', productName: 'Coca-Cola 0.5L', qty: '10', unitPrice: '15000', lineTotal: '150000' },
          ],
        },
        {
          id: 'pay-1',
          number: 'PAY-2026-000001',
          date: new Date('2026-08-01T09:30:00Z'),
          operation: 'Оплата от покупателя',
          customerId: 'cust-1',
          total: '150000.00',
        },
      ],
    });

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('ВерсияСхемы="2.10"');
    // <Контрагент> also appears once per <Документ> (an id-only reference to
    // its customer) and <Наименование> also appears once per <Товар> (the
    // product name) — so the unambiguous way to count top-level customers is
    // to only look at the XML before the <Документы> section starts.
    const [beforeDocuments] = xml.split('<Документы>');
    expect((beforeDocuments!.match(/<Контрагент>/g) ?? []).length).toBe(1);
    expect((xml.match(/<Документ>/g) ?? []).length).toBe(2);
    expect(xml).toContain('<ХозОперация>Отгрузка товара</ХозОперация>');
    expect(xml).toContain('<ХозОперация>Оплата от покупателя</ХозОперация>');
    expect(xml).toContain('<Товар>');
  });

  it('escapes XML-significant characters in free-text fields', () => {
    const xml = buildCommerceMlXml({
      generatedAt,
      currency: 'UZS',
      customers: [{ id: 'cust-1', code: 'C-1', name: 'Do\'kon "A&B" <Ltd>', phone: null }],
      documents: [],
    });

    // escapeXml escapes the apostrophe too (&apos;), not just the characters
    // that are strictly required outside of apostrophe-delimited attributes.
    expect(xml).toContain('Do&apos;kon &quot;A&amp;B&quot; &lt;Ltd&gt;');
    expect(xml).not.toContain('"A&B" <Ltd>');
  });

  it('never emits <ИНН> (INN dropped from the product) and omits <Телефон> when absent, and omits <Товары> for documents without lines (payments)', () => {
    const xml = buildCommerceMlXml({
      generatedAt,
      currency: 'UZS',
      customers: [{ id: 'cust-1', code: 'C-1', name: 'No TIN Co', phone: null }],
      documents: [
        { id: 'pay-1', number: 'PAY-1', date: generatedAt, operation: 'Оплата от покупателя', customerId: 'cust-1', total: '1000' },
      ],
    });

    expect(xml).not.toContain('<ИНН>');
    expect(xml).not.toContain('<Телефон>');
    expect(xml).not.toContain('<Товары>');
  });

  it('falls back to the product SKU as <Ид> when externalCode is missing (11.1)', () => {
    const xml = buildCommerceMlXml({
      generatedAt,
      currency: 'UZS',
      customers: [{ id: 'cust-1', code: 'C-1', name: 'Co', phone: null }],
      documents: [
        {
          id: 'inv-1',
          number: 'INV-1',
          date: generatedAt,
          operation: 'Отгрузка товара',
          customerId: 'cust-1',
          total: '1000',
          lines: [{ externalCode: null, sku: 'SKU-FALLBACK', productName: 'X', qty: '1', unitPrice: '1000', lineTotal: '1000' }],
        },
      ],
    });

    expect(xml).toContain('<Ид>SKU-FALLBACK</Ид>');
  });
});
