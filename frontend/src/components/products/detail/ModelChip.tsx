/**
 * A printer model, as the catalog's «Printers» chips draw it (`ProductModels`, WS-13 E8
 * B04) — the product page's sources, files and the re-read list use the same chip.
 */
export function ModelChip({ model }: { model: string }) {
  return (
    <span
      data-testid="product-model-chip"
      className="inline-block rounded px-1.5 text-[11px] leading-5 bg-blue-500/15 text-blue-700 dark:text-blue-300"
    >
      {model}
    </span>
  );
}
