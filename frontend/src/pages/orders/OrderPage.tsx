import { useNavigate, useParams } from 'react-router';
import { OrderView } from '../../components/projects/OrderView';

/** The route `/projects/:id` — the order view on a page of its own; a deleted order goes back to the list. */
export function OrderPage() {
  const { id: idParam } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // `workshop` — the section's 14/21 text scope (WS-13 E2 B02); keyed by id, so
  // another order starts from nothing: its tabs, drafts and dialogs (E3 F03).
  return (
    <div className="workshop">
      <OrderView key={idParam} id={Number(idParam)} onDeleted={() => navigate('/projects')} />
    </div>
  );
}
