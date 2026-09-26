import { useNavigate, useParams } from 'react-router';
import { OrderView } from '../../components/projects/OrderView';

/** The route `/projects/:id` — the order view on a page of its own; a deleted order goes back to the list. */
export function OrderPage() {
  const { id: idParam } = useParams<{ id: string }>();
  const navigate = useNavigate();
  return <OrderView id={Number(idParam)} onDeleted={() => navigate('/projects')} />;
}
