/**
 * Field wrapped its hint and error inside the <label>, so both became part of
 * the control's accessible name — a description read as a name, and a name
 * that changed the moment an error appeared.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Field, TextInput, Select } from '../Field';

afterEach(() => cleanup());

describe('Field — the hint is a description, not part of the name', () => {
  it('names the control by its label alone', () => {
    render(
      <Field label="Activity level" hint="On your feet often — roughly 7,500–10,000 steps/day">
        <Select>
          <option value="">Select…</option>
        </Select>
      </Field>,
    );

    expect(screen.getByRole('combobox', { name: 'Activity level' })).toBeInTheDocument();
  });

  it('exposes the hint as a description', () => {
    render(
      <Field label="Weight" hint="Saved as a weights record">
        <TextInput />
      </Field>,
    );

    expect(screen.getByRole('textbox', { name: 'Weight' })).toHaveAccessibleDescription(
      'Saved as a weights record',
    );
  });

  it('keeps the name stable when an error replaces the hint', () => {
    const { rerender } = render(
      <Field label="Email" hint="We never share it">
        <TextInput />
      </Field>,
    );
    expect(screen.getByRole('textbox', { name: 'Email' })).toBeInTheDocument();

    rerender(
      <Field label="Email" error="That address isn't valid">
        <TextInput />
      </Field>,
    );

    // Same name; the error is a description, and the control is marked invalid.
    const input = screen.getByRole('textbox', { name: 'Email' });
    expect(input).toHaveAccessibleDescription("That address isn't valid");
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('leaves a control with no hint undescribed and valid', () => {
    render(
      <Field label="Height">
        <TextInput />
      </Field>,
    );

    const input = screen.getByRole('textbox', { name: 'Height' });
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).toHaveAccessibleDescription('');
  });

  it('does not confuse one field’s hint with another field’s label', () => {
    render(
      <>
        <Field label="Activity level" hint="On your feet often">
          <Select>
            <option value="">Select…</option>
          </Select>
        </Field>
        <Field label="Height (feet)">
          <TextInput />
        </Field>
      </>,
    );

    // Previously the hint text made the select match /feet/ as a label too.
    expect(screen.getByLabelText(/feet/i)).toHaveAccessibleName('Height (feet)');
  });
});
