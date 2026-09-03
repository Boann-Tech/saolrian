import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Field, TextInput, Select } from '../Field';
import { Stepper } from '../Stepper';
import { Segmented } from '../Segmented';

describe('Field', () => {
  it('associates the label and shows the hint', () => {
    render(
      <Field label="Height" hint="in centimetres">
        <TextInput />
      </Field>,
    );
    expect(screen.getByText('Height')).toBeInTheDocument();
    expect(screen.getByText('in centimetres')).toBeInTheDocument();
  });

  it('error replaces hint and uses danger colour', () => {
    render(
      <Field label="Email" hint="we never share it" error="required">
        <TextInput />
      </Field>,
    );
    expect(screen.queryByText('we never share it')).not.toBeInTheDocument();
    expect(screen.getByText('required').className).toMatch(/text-danger/);
  });
});

describe('Select', () => {
  it('renders options', () => {
    render(
      <Select defaultValue="a">
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    );
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });
});

describe('Stepper', () => {
  it('increments and decrements by step, clamped to min', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Stepper value={2} step={2} min={0} onChange={onChange} aria-label="servings" />);
    await user.click(screen.getByRole('button', { name: /increase/i }));
    expect(onChange).toHaveBeenLastCalledWith(4);
    await user.click(screen.getByRole('button', { name: /decrease/i }));
    expect(onChange).toHaveBeenLastCalledWith(0);
  });
});

describe('Segmented', () => {
  it('marks the active option and fires onChange', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Segmented
        value="lose"
        onChange={onChange}
        options={[
          { value: 'lose', label: 'Lose' },
          { value: 'maintain', label: 'Maintain' },
        ]}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Lose' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Maintain' }));
    expect(onChange).toHaveBeenCalledWith('maintain');
  });
});
