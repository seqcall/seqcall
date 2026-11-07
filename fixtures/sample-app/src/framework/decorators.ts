/** Minimal framework-style decorators (never executed; only analysed). */
export function Controller(basePath: string) {
  return (target: Function): void => {
    Reflect.set(target, 'basePath', basePath);
  };
}

export function Injectable() {
  return (target: Function): void => {
    Reflect.set(target, 'injectable', true);
  };
}
