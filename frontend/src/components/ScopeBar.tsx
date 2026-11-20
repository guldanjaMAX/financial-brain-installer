import { useEffect, useRef, useState } from "react";
import type { FinEntity } from "../lib/api";
import { orderedScopes, visibleScopes } from "../lib/finance";

const FIND_AT = 7;

/** One scope model for every financial screen. An owned financial entity can
 *  be a person, household, trust, business, property, or investment. */
export function ScopeBar({
  entities, value, onChange, disabled = false, choiceMade = value !== null, requireEntity = false,
}: {
  entities: FinEntity[];
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
  choiceMade?: boolean;
  requireEntity?: boolean;
}) {
  const [query, setQuery] = useState("");
  const choicesRef = useRef<HTMLDivElement>(null);
  const ordered = orderedScopes(entities);
  const shown = visibleScopes(entities, query, value);
  const q = query.trim().toLocaleLowerCase();
  const choiceRequired = !choiceMade || (requireEntity && value === null);
  const foundAdded = !q || ordered.some((entity) =>
    entity.label.toLocaleLowerCase().includes(q));

  const choose = (next: string | null) => {
    setQuery("");
    onChange(next);
  };

  useEffect(() => {
    choicesRef.current?.querySelector<HTMLElement>("[aria-pressed='true']")
      ?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [value]);

  return (
    <div className={choiceRequired ? "mb-6 rounded-2xl border border-line bg-card p-4 sm:p-5" : "mb-6"} role="group" aria-label="Financial entity selection">
      {choiceRequired && (
        <div role="status" className="mb-4 text-ink-soft">
          {requireEntity ? (
            <p className="text-[14px] leading-relaxed">
              Pick one person, household, business, trust, property, or investment below.
            </p>
          ) : (
            <p className="text-[14px] leading-relaxed">
              Choose Whole Brain to include all evidence, or choose one item below to narrow the page.
            </p>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-3 mb-2">
        {!choiceRequired && <span className="text-[12.5px] font-medium uppercase tracking-[0.08em] text-ink-soft">
          {value === null ? "Showing" : "Selected"}
        </span>}
        {ordered.length >= FIND_AT && (
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a person or entity"
            aria-label="Find a person or financial entity"
            className="min-h-11 w-44 max-w-full text-[16px] px-3 py-2 rounded-lg border border-line-strong bg-card outline-none focus:border-accent"
          />
        )}
      </div>
      <div
        ref={choicesRef}
        className={choiceRequired
          ? "flex flex-wrap gap-2 pb-2 -mb-2"
          : "flex flex-nowrap gap-2 overflow-x-auto pb-2 -mb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"}
      >
        {!requireEntity && (
          <ScopeChoice active={choiceMade && value === null} disabled={disabled} onClick={() => choose(null)}>
            Whole Brain
          </ScopeChoice>
        )}
        {shown.map((entity) => (
          <ScopeChoice
            key={entity.entity_slug}
            active={value === entity.entity_slug}
            disabled={disabled}
            onClick={() => choose(entity.entity_slug)}
          >
            {entity.label}
          </ScopeChoice>
        ))}
        {q && !foundAdded && (
          <span className="text-[13px] text-ink-soft py-2 whitespace-nowrap">
            No person or financial entity by that name is here.
          </span>
        )}
        {!q && shown.length === 0 && (
          <span className="text-[13px] text-ink-soft py-2">
            No person or financial entity is available to choose yet.
          </span>
        )}
      </div>
    </div>
  );
}

function ScopeChoice({ active, disabled, onClick, children }: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`min-h-11 max-w-full text-left break-words text-[15px] font-medium px-3.5 py-2 rounded-xl border transition-colors disabled:opacity-60 ${
        active
          ? "bg-accent text-white border-accent"
          : "bg-card text-ink-soft border-line hover:text-ink hover:border-accent"
      }`}
    >
      {children}
    </button>
  );
}
