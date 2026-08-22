import { useEffect, useRef } from 'react';

/**
 * Auto-logout after a period of inactivity — a HIPAA/SOC2 automatic-logoff
 * control (§164.312(a)(2)(iii)). Also fires when the tab is hidden past the
 * timeout. Activity resets the timer.
 */
export function useIdleTimeout(onIdle, { minutes = 15 } = {}) {
  const timer = useRef(null);
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  useEffect(() => {
    const ms = minutes * 60 * 1000;
    const reset = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => onIdleRef.current?.(), ms);
    };
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'visibilitychange'];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [minutes]);
}
