import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { ActionForm } from './actions';
afterEach(cleanup);
test('a failed action retries its original values and idempotency key, then disables duplicate submission',async()=>{
 const user=userEvent.setup(); const save=vi.fn().mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValueOnce({});
 render(<ActionForm title="Save action" save={save}><label>Reason<input name="reason" defaultValue="Reviewed"/></label></ActionForm>);
 await user.click(screen.getByRole('button',{name:'Save action'}));
 await screen.findByText('Network unavailable');
 expect((screen.getByLabelText('Reason') as HTMLInputElement).disabled).toBe(false);
 expect(screen.getByLabelText('Reason').closest('fieldset')?.disabled).toBe(true);
 await user.click(screen.getByRole('button',{name:'Retry same action'}));
 await screen.findByText('Server confirmed this action.');
 expect(save.mock.calls[0]).toEqual(save.mock.calls[1]);
 expect((screen.getByRole('button',{name:'Save action'}) as HTMLButtonElement).disabled).toBe(true);
});
