import { useRef } from 'react';

/**
 * Segmented one-time-code input — the enterprise 2FA pattern: N single-digit boxes with auto-advance,
 * backspace/arrow navigation, full-code paste, and browser one-time-code autofill. Controlled via a
 * packed digit string (`value`); calls `onComplete` when all boxes are filled (for auto-submit).
 */
export default function OtpInput({
  value = '', onChange, onComplete, length = 6, autoFocus = false,
  disabled = false, invalid = false, ariaLabel = 'Verification code',
}) {
  const inputs = useRef([]);
  const chars = Array.from({ length }, (_, i) => value[i] ?? '');

  const emit = (arr) => {
    const next = arr.join('');
    onChange?.(next);
    if (next.length === length && !arr.includes('')) onComplete?.(next);
  };
  const focusBox = (i) => {
    const el = inputs.current[Math.max(0, Math.min(length - 1, i))];
    if (el) { el.focus(); el.select(); }
  };

  const handleChange = (i, e) => {
    const digits = e.target.value.replace(/\D/g, '');
    if (!digits) return; // deletions are handled in keydown
    const arr = [...chars];
    if (digits.length > 1) { // paste / autofill landing in one box
      let pos = i;
      for (const d of digits) { if (pos >= length) break; arr[pos] = d; pos += 1; }
      emit(arr); focusBox(pos);
    } else {
      arr[i] = digits; emit(arr);
      if (i < length - 1) focusBox(i + 1);
    }
  };

  const handleKeyDown = (i, e) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const arr = [...chars];
      if (arr[i]) { arr[i] = ''; emit(arr); } else if (i > 0) { arr[i - 1] = ''; emit(arr); focusBox(i - 1); }
    } else if (e.key === 'ArrowLeft') { e.preventDefault(); focusBox(i - 1); } else if (e.key === 'ArrowRight') { e.preventDefault(); focusBox(i + 1); } else if (e.key === 'Home') { e.preventDefault(); focusBox(0); } else if (e.key === 'End') { e.preventDefault(); focusBox(length - 1); }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, length);
    if (!digits) return;
    emit(Array.from({ length }, (_, k) => digits[k] ?? ''));
    focusBox(digits.length);
  };

  return (
    <div className="otp" role="group" aria-label={ariaLabel} onPaste={handlePaste}>
      {chars.map((c, i) => (
        <input
          key={i}
          ref={(el) => { inputs.current[i] = el; }}
          className={`otp-box${c ? ' filled' : ''}${i === length / 2 ? ' otp-gap' : ''}`}
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          value={c}
          disabled={disabled}
          aria-label={`Digit ${i + 1} of ${length}`}
          aria-invalid={invalid || undefined}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={autoFocus && i === 0}
          onChange={(e) => handleChange(i, e)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}
