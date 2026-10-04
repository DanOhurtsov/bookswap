interface SpellingSuggestionProps {
  text: string
  onPick: (text: string) => void
}

/**
 * Рядок «Можливо, ви шукали «…»?» під полем пошуку: другорядний текст без картки, а сама назва — кнопка,
 * оформлена як посилання (нативний `<button>`: Tab фокусує, Enter і Пробіл натискають).
 */
export function SpellingSuggestion({ text, onPick }: SpellingSuggestionProps) {
  return (
    <p className="col-start-1 -mt-1.5 text-[0.9rem] text-(--bookswap-muted)">
      Можливо, ви шукали «
      <button
        type="button"
        className="cursor-pointer rounded-sm text-(--bookswap-accent) underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        onClick={() => {
          onPick(text)
        }}
      >
        {text}
      </button>
      »?
    </p>
  )
}
