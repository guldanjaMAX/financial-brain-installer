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
    <div className="mb-6" role="group" aria-label="Financial entity selection">
      {choiceRequired && (
        <div role="status" className="mb-4 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-4 text-amber-950 sm:px-5">
          <p className="text-[15px] font-semibold">{requireEntity ? "Choose one part of your finances to continue" : "Choose what to view"}</p>
          {requireEntity ? (
            <p className="mt-1.5 text-[13.5px] leading-relaxed">
              Pick one person, household, business, trust, property, or investment below.
              Financial Brain will not choose one for you or combine separate finances into one editable view.
            </p>
          ) : (
            <p className="mt-1.5 text-[13.5px] leading-relaxed">
              Choose Whole Brain to include all evidence, or choose one item below to narrow the page.
              Financial Brain will not silently choose for you.
            </p>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-3 mb-2">
        <span className="text-[12.5px] font-medium uppercase tracking-[0.08em] text-ink-soft">
          {choiceRequired ? (requireEntity ? "Choose one" : "Choose a view")
            : value === null ? "Showing" : "Selected"}
        </span>
        {ordered.length >= FIND_AT && (
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a person or entity"
            aria-label="Find a person or financial entity"
            className="w-44 max-w-[58vw] text-[13px] px-3 py-2 rounded-lg border border-line bg-card outline-none focus:border-accent"
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
      className={`shrink-0 text-[13.5px] font-medium px-3.5 py-2 rounded-xl border transition-colors disabled:opacity-60 ${
        active
          ? "bg-accent text-white border-accent"
          : "bg-card text-ink-soft border-line hover:text-ink hover:border-accent"
      }`}
    >
      {children}
    </button>
  );
}
